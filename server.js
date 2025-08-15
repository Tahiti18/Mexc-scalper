import 'dotenv/config';
import express from 'express';
import ccxt from 'ccxt';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();

// capture raw JSON
let raw = Buffer.alloc(0);
app.use((req,res,next)=>{
  const chunks=[]; req.on('data',c=>chunks.push(c));
  req.on('end',()=>{ raw=Buffer.concat(chunks); try{ req.body=JSON.parse(raw.toString('utf8')||'{}'); }catch{ req.body={}; } next(); });
});

// env
const E=(k,d=null)=>process.env[k]??d;
const PORT = Number(E('PORT',8080));
const DRY  = String(E('DRY_RUN','true')).toLowerCase()==='true';
const SECRET = E('WEBHOOK_SECRET','');
const DASHBOARD_TOKEN = E('DASHBOARD_TOKEN','');

const DEFAULT_SYMBOL = E('DEFAULT_SYMBOL','BTC/USDT:USDT');
const DEFAULT_NOTIONAL = Number(E('DEFAULT_NOTIONAL_USDT',25));
const DEFAULT_LEVERAGE = Number(E('DEFAULT_LEVERAGE',20));
const DEFAULT_ISOLATED = String(E('DEFAULT_ISOLATED','true')).toLowerCase()==='true';

const MAX_TRADES_PER_HOUR = Number(E('MAX_TRADES_PER_HOUR',30));
const MAX_SPREAD_PCT = Number(E('MAX_SPREAD_PCT',0.03));
const REJECT_IF_THIN_BOOK = String(E('REJECT_IF_THIN_BOOK','true')).toLowerCase()==='true';
const COOLDOWN_AFTER_LOSS_SEC = Number(E('COOLDOWN_AFTER_LOSS_SEC',120));

const MAX_CONSEC_LOSSES = Number(E('MAX_CONSEC_LOSSES',3));
const LOSS_HALT_COOLDOWN_MIN = Number(E('LOSS_HALT_COOLDOWN_MIN',10));
const LOSS_REDUCE_FACTORS = (()=>{ try{ return JSON.parse(E('LOSS_REDUCE_FACTORS','[1.0,0.7,0.4]')); }catch{ return [1.0,0.7,0.4]; } })();
const LOSS_MIN_NOTIONAL = Number(E('LOSS_MIN_NOTIONAL',5));

const DAILY_PNL_CAP_USDT = Number(E('DAILY_PNL_CAP_USDT',0));
const DAILY_RESET_HOUR_UTC = Number(E('DAILY_RESET_HOUR_UTC',0));

const HMAC_ENABLED = String(E('HMAC_ENABLED','false')).toLowerCase()==='true';
const HMAC_SECRET = E('HMAC_SECRET','');
const HMAC_HEADER = E('HMAC_HEADER','X-Signature');

// exchange
const mexc = new ccxt.mexc({
  apiKey: E('MEXC_KEY',''),
  secret: E('MEXC_SECRET',''),
  enableRateLimit: true,
  options: { defaultType: 'swap' }
});

// state
const now=()=>Date.now();
const tradeTimes=[];
const cooldownUntil=new Map();
const lossStreak=new Map();
const haltedUntil=new Map();
const lastSpread=new Map();
const daily={ key:'', pnl:0, trades:0 };
const inv=new Map();
const fills=[];    // csv rows
const events=[];   // log lines

function log(s){ const e=`[${new Date().toISOString()}] ${s}`; events.push(e); if(events.length>2000) events.splice(0, events.length-2000); }
function pruneHour(arr){ const cut=now()-3600*1000; while(arr.length && arr[0]<cut) arr.shift(); }
function startBucket(){
  const d=new Date(); const h=DAILY_RESET_HOUR_UTC;
  const b=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),h,0,0,0));
  if (d.getUTCHours()<h) b.setUTCDate(b.getUTCDate()-1);
  return b;
}
function ensureBucket(){
  const key = startBucket().toISOString().slice(0,10)+`@${DAILY_RESET_HOUR_UTC}`;
  if (daily.key!==key){ daily.key=key; daily.pnl=0; daily.trades=0; fills.length=0; inv.clear(); lossStreak.clear(); haltedUntil.clear(); log('Daily reset '+key); }
}

// *** PATCHED verify() — adds support for ?secret= in URL (TradingView-friendly) ***
function verify(req){
  // 1) Allow ?secret=... (works with TradingView which can’t add headers)
  try {
    const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
    const qsSecret = url.searchParams.get('secret');
    if (qsSecret && SECRET && qsSecret === SECRET) return true;
  } catch {}

  // 2) Original header-based check for forwarders that set headers
  const basic = SECRET && (req.get('X-Webhook-Secret')===SECRET);

  // 3) Optional HMAC (if you later put a signing forwarder in front)
  if (!HMAC_ENABLED) return basic;
  const sig=req.get(HMAC_HEADER)||'';
  const mac=crypto.createHmac('sha256', HMAC_SECRET).update(raw||Buffer.from('')).digest('hex');
  return basic || (sig && sig===mac);
}

async function spreadPct(sym){
  const ob=await mexc.fetchOrderBook(sym,5).catch(()=>null);
  if(!ob || !ob.bids?.length || !ob.asks?.length){ if(REJECT_IF_THIN_BOOK) throw new Error('thin_book'); return Infinity; }
  const bid=ob.bids[0][0], ask=ob.asks[0][0];
  const pct=((ask-bid)/((ask+bid)/2))*100; lastSpread.set(sym,pct); return pct;
}
async function notionalToAmount(sym, usdt){
  const t=await mexc.fetchTicker(sym);
  const px=t.last || Number(t.info?.lastPrice) || 0;
  if(!px) throw new Error('no_price');
  return Number(mexc.amountToPrecision(sym, usdt/px));
}
async function ensureLev(sym, lev){
  try{ if(!DRY){ await mexc.setLeverage(lev, sym, { marginMode: DEFAULT_ISOLATED?'isolated':'cross' }); if(DEFAULT_ISOLATED) await mexc.setMarginMode('isolated', sym); } }
  catch(e){ log('Leverage set warn: '+e.message); }
}
function isHalted(sym){
  const u=haltedUntil.get(sym); if(u===undefined) return false;
  if(u===0) return true;
  if(now()>=u){ haltedUntil.delete(sym); lossStreak.set(sym,0); return false; }
  return true;
}
function reducedNotional(sym, base){
  const s=(lossStreak.get(sym)||0);
  const idx=Math.min(s, Math.max(0, LOSS_REDUCE_FACTORS.length-1));
  const f=Number(LOSS_REDUCE_FACTORS[idx]||1);
  return Math.max(LOSS_MIN_NOTIONAL, base*f);
}
function markFill(sym, side, price, amount, fee){
  if (!inv.has(sym)) inv.set(sym, { pos:0, avg:0 });
  const st=inv.get(sym);
  let realized=-(fee||0);
  const signed=(side==='buy'?1:-1)*amount;

  if ((st.pos >= 0 && signed > 0) || (st.pos <= 0 && signed < 0)){
    const newPos=st.pos+signed;
    if (Math.sign(st.pos)===Math.sign(newPos) || st.pos===0){
      const notOld=Math.abs(st.pos)*st.avg;
      const notAdd=Math.abs(signed)*price;
      const newAbs=Math.abs(newPos);
      st.avg = newAbs ? (notOld + notAdd)/newAbs : 0;
      st.pos = newPos;
      inv.set(sym, st);
      fills.push({ ts: now(), symbol: sym, side, price, amount, fee, realized });
      return realized;
    }
  }
  if ((st.pos > 0 && signed < 0) || (st.pos < 0 && signed > 0)){
    let rem=Math.abs(signed);
    while (rem>0 && st.pos!==0){
      const closable=Math.min(Math.abs(st.pos), rem);
      const dir=st.pos>0?1:-1;
      const pnlPer=dir===1?(price - st.avg):(st.avg - price);
      realized += pnlPer*closable;
      st.pos += -dir*closable;
      rem -= closable;
      if (st.pos===0) st.avg=0;
    }
    if (rem>0){
      const ns=(signed>0?1:-1)*rem;
      const notOld=Math.abs(st.pos)*st.avg;
      const notAdd=Math.abs(ns)*price;
      const newAbs=Math.abs(st.pos+ns);
      st.avg = newAbs ? (notOld + notAdd)/newAbs : 0;
      st.pos = st.pos + ns;
    }
    inv.set(sym, st);
  }
  fills.push({ ts: now(), symbol: sym, side, price, amount, fee, realized });
  daily.pnl += realized;
  if (realized<0){
    lossStreak.set(sym, (lossStreak.get(sym)||0)+1);
    if (COOLDOWN_AFTER_LOSS_SEC>0) cooldownUntil.set(sym, now()+COOLDOWN_AFTER_LOSS_SEC*1000);
    if (MAX_CONSEC_LOSSES>0 && (lossStreak.get(sym)||0)>=MAX_CONSEC_LOSSES){
      haltedUntil.set(sym, LOSS_HALT_COOLDOWN_MIN>0 ? now()+LOSS_HALT_COOLDOWN_MIN*60*1000 : 0);
    }
  } else if (realized>0){
    lossStreak.set(sym, 0);
  }
  if (fills.length>5000) fills.splice(0, fills.length-5000);
}

// static assets
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get('/', (req,res)=>{
  const ok = !DASHBOARD_TOKEN || req.get('X-Dashboard-Token')===DASHBOARD_TOKEN || (new URL(req.protocol+'://'+req.get('host')+req.originalUrl)).searchParams?.get('token')===DASHBOARD_TOKEN;
  if (!ok) return res.status(401).send('<h3>Unauthorized</h3>');
  res.set('content-type','text/html; charset=utf-8').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/public/style.css">
  <title>MEXC Relay</title></head><body>
  <h1>MEXC Relay</h1>
  <div class="card">
    <span class="pill">DRY: ${DRY}</span>
    <a class="pill" href="/pnl.csv">pnl.csv</a>
    <a class="pill" href="/config">config</a>
    <a class="pill" href="/logs.csv">logs.csv</a>
  </div>
  <div class="card"><pre id="h">Loading...</pre></div>
  <script src="/public/app.js"></script>
  </body></html>`);
});
app.use('/public', express.static(path.join(__dirname, 'public')));

// endpoints
app.get('/health', (req,res)=>{
  ensureBucket();
  pruneHour(tradeTimes);
  const cd={};
  for (const [s,t] of cooldownUntil.entries()){
    const left=Math.max(0, Math.round((t-now())/1000));
    if (left>0) cd[s]=left; else cooldownUntil.delete(s);
  }
  const halted={};
  for (const [s,t] of haltedUntil.entries()){
    halted[s] = t===0 ? 'manual' : Math.max(0, Math.round((t-now())/1000))+'s';
  }
  res.json({ ok:true, dry:DRY, dailyKey:daily.key, tradesToday:daily.trades, pnlToday:Number(daily.pnl.toFixed(6)), tradesLastHour:tradeTimes.length, cooldown:cd, halted, lastSpreadPct:Object.fromEntries([...lastSpread.entries()].map(([s,v])=>[s, Number(v.toFixed(4))])) });
});
app.get('/config', (req,res)=>{
  res.json({ ok:true, dry:DRY, defaults:{DEFAULT_SYMBOL,DEFAULT_NOTIONAL,DEFAULT_LEVERAGE,DEFAULT_ISOLATED}, guards:{MAX_TRADES_PER_HOUR,MAX_SPREAD_PCT,REJECT_IF_THIN_BOOK,COOLDOWN_AFTER_LOSS_SEC}, loss:{MAX_CONSEC_LOSSES,LOSS_HALT_COOLDOWN_MIN,LOSS_REDUCE_FACTORS,LOSS_MIN_NOTIONAL}, pnl:{DAILY_PNL_CAP_USDT,DAILY_RESET_HOUR_UTC} });
});
app.get('/pnl.csv', (req,res)=>{
  ensureBucket();
  res.set('content-type','text/csv; charset=utf-8');
  res.write('ts_iso,symbol,side,price,amount,fee_usdt,realized_usdt\n');
  for (const f of fills) res.write(`${new Date(f.ts).toISOString()},${f.symbol},${f.side},${f.price},${f.amount},${(f.fee||0).toFixed(6)},${(f.realized||0).toFixed(6)}\n`);
  res.end();
});
app.get('/logs.csv', (req,res)=>{
  res.set('content-type','text/csv; charset=utf-8');
  res.write('ts_iso,event\n');
  for (const e of events) res.write(`${e.slice(1,25)},${e.replace(/^[^\\]]+\\]\\s*/,'').replace(/,/g,';')}\n`);
  res.end();
});

app.post('/admin/halt', (req,res)=>{ const s=(req.body?.symbol||DEFAULT_SYMBOL).toUpperCase(); haltedUntil.set(s, 0); res.json({ ok:true, halted:s }); });
app.post('/admin/unhalt', (req,res)=>{ const s=(req.body?.symbol||DEFAULT_SYMBOL).toUpperCase(); haltedUntil.delete(s); lossStreak.set(s,0); res.json({ ok:true, unhalted:s }); });
app.post('/admin/cooldown', (req,res)=>{ const s=(req.body?.symbol||DEFAULT_SYMBOL).toUpperCase(); const sec=Number(req.body?.seconds||60); cooldownUntil.set(s, now()+sec*1000); res.json({ ok:true, cooldown:{ symbol:s, seconds:sec } }); });

app.post('/webhook', async (req,res)=>{
  try{
    if (!verify(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
    ensureBucket();

    const b=req.body||{};
    const signal=String(b.signal||'').toUpperCase();
    const rawSymbol=(b.symbol||DEFAULT_SYMBOL).toUpperCase();
    const symbol=rawSymbol.includes('/')? rawSymbol : DEFAULT_SYMBOL;
    const lev=Number(b.leverage||DEFAULT_LEVERAGE);
    const baseNotional=Number(b.notional||DEFAULT_NOTIONAL);
    const relayTimer=Boolean(b.relayTimer);
    const autoCloseSec=Number(b.autoCloseSec||0);

    if (isHalted(symbol)) return res.status(423).json({ ok:false, error:'halted' });

    pruneHour(tradeTimes);
    if (tradeTimes.length >= MAX_TRADES_PER_HOUR) return res.status(429).json({ ok:false, error:'rate_limited' });

    const sp=await spreadPct(symbol);
    if (sp > MAX_SPREAD_PCT) return res.status(400).json({ ok:false, error:'wide_spread', spreadPct: sp });

    await ensureLev(symbol, lev);
    const notional=reducedNotional(symbol, baseNotional);
    const amt=await notionalToAmount(symbol, notional);

    // place
    if (!DRY){
      if (signal==='LONG') await mexc.createMarketBuyOrder(symbol, amt);
      else if (signal==='SHORT') await mexc.createMarketSellOrder(symbol, amt);
      else if (signal==='CLOSE_LONG') await mexc.createMarketSellOrder(symbol, amt);
      else if (signal==='CLOSE_SHORT') await mexc.createMarketBuyOrder(symbol, amt);
      else return res.status(400).json({ ok:false, error:'bad_signal' });
    }
    tradeTimes.push(now());
    daily.trades += 1;
    log(`EXEC ${signal} ${symbol} notional=${notional} lev=${lev}`);

    // schedule auto-close
    if (!DRY && relayTimer && autoCloseSec>0 && (signal==='LONG' || signal==='SHORT')){
      setTimeout(async ()=>{
        try{
          const side = (signal==='LONG') ? 'sell' : 'buy';
          const t = await mexc.fetchTicker(symbol);
          const px = t.last || Number(t.info?.lastPrice) || 0;
          const fee = 0;
          if (side==='buy') markFill(symbol, 'buy', px, amt, fee);
          else markFill(symbol, 'sell', px, amt, fee);
          if (signal==='LONG') await mexc.createMarketSellOrder(symbol, amt);
          if (signal==='SHORT') await mexc.createMarketBuyOrder(symbol, amt);
          log(`AUTO-CLOSE ${symbol} after ${autoCloseSec}s`);
        }catch(e){ log('auto-close error: '+(e?.message||e)); }
      }, autoCloseSec*1000);
    }

    res.json({ ok:true, dry:DRY, symbol, signal, lev, notionalUSDT:notional, autoCloseSec, spreadPct: sp });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// background: poll trades to account fees & PnL incrementally (best effort)
async function pollFills(){
  try{
    ensureBucket();
    const symbols=new Set([DEFAULT_SYMBOL]);
    for(const s of symbols){
      const trades=await mexc.fetchMyTrades(s, undefined, 100).catch(()=>[]);
      for(const t of trades){
        const id=`${t.id}:${t.symbol}`;
        if (fills.find(x=>x.id===id)) continue;
        const fee=(t.fee && t.fee.cost && (t.fee.currency||'').toUpperCase()==='USDT') ? Number(t.fee.cost) : 0;
        const side=(t.side||'').toLowerCase();
        const price=Number(t.price);
        const amount=Math.abs(Number(t.amount));
        markFill(t.symbol, side, price, amount, fee);
        fills[fills.length-1].id=id;
      }
      if (fills.length>5000) fills.splice(0, fills.length-5000);
    }
  }catch(e){ /* ignore */ }
}
setInterval(pollFills, 15000);

app.listen(PORT, ()=> console.log(`[relay] listening on :${PORT}, DRY_RUN=${DRY}`));
