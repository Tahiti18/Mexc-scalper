import 'dotenv/config';
import express from 'express';
import ccxt from 'ccxt';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * MEXC Scalper Relay — Advanced (NO SIMULATOR)
 * - Webhook receiver for TradingView alerts (/webhook)
 * - Guards: rate-limit per hour, spread limit, per-symbol cooldown, loss-streak halt
 * - Paper mode (DRY_RUN=true): simulates fills so charts & stats update
 * - Auto-close (optional) via relayTimer + autoCloseSec
 * - SSE live stream (/stream) for dashboard
 * - CSV exports: /pnl.csv , /logs.csv
 * - JSON APIs: /stats , /stats/daily , /fills , /logs , /config , /health
 * - Admin endpoints: /admin/halt, /admin/unhalt, /admin/cooldown, /admin/halt_all, /admin/unhalt_all, /admin/reset, /admin/toggle_dry
 * - Background fill sync with CCXT (fetchMyTrades) every 15s
 * - Optimizer: /optimizer/suggest → OpenRouter (optional)
 */

const app = express();
// --- Health probe
app.get('/ping', (req, res) => {
  res.type('text/plain').send('pong');
});

// Capture raw body only for POST-like requests so GET/HEAD never hang
let rawBody = Buffer.alloc(0);
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    rawBody = Buffer.alloc(0);
    req.body = {};
    return next();
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    rawBody = Buffer.concat(chunks);
    try { req.body = JSON.parse(rawBody.toString('utf8') || '{}'); }
    catch { req.body = {}; }
    next();
  });
  req.on('error', () => { rawBody = Buffer.alloc(0); req.body = {}; next(); });
});

// Helper to read env with default
const E = (k, d = null) => process.env[k] ?? d;

// ---- Core env
const PORT = Number(E('PORT', 8080));
let DRY  = String(E('DRY_RUN', 'true')).toLowerCase() === 'true'; // let so we can toggle at runtime
const SECRET = E('WEBHOOK_SECRET', '');
const DASHBOARD_TOKEN = E('DASHBOARD_TOKEN', '');

// Defaults (override via env DEFAULT_SYMBOL, etc.)
const DEFAULT_SYMBOL   = E('DEFAULT_SYMBOL', 'BTC/USDT:USDT').toUpperCase();
const DEFAULT_NOTIONAL = Number(E('DEFAULT_NOTIONAL_USDT', 20));
const DEFAULT_LEVERAGE = Number(E('DEFAULT_LEVERAGE', 100));
const DEFAULT_ISOLATED = String(E('DEFAULT_ISOLATED', 'true')).toLowerCase() === 'true';

// Guards
const MAX_TRADES_PER_HOUR     = Number(E('MAX_TRADES_PER_HOUR', 60));
const MAX_SPREAD_PCT          = Number(E('MAX_SPREAD_PCT', 0.03)); // 0.03% default
const REJECT_IF_THIN_BOOK     = String(E('REJECT_IF_THIN_BOOK','true')).toLowerCase()==='true';
const COOLDOWN_AFTER_LOSS_SEC = Number(E('COOLDOWN_AFTER_LOSS_SEC', 120));

// Loss-streak handling
const MAX_CONSEC_LOSSES      = Number(E('MAX_CONSEC_LOSSES', 3));
const LOSS_HALT_COOLDOWN_MIN = Number(E('LOSS_HALT_COOLDOWN_MIN', 10));
const LOSS_REDUCE_FACTORS    = (()=> { try { return JSON.parse(E('LOSS_REDUCE_FACTORS','[1.0,0.7,0.4]')); } catch { return [1.0,0.7,0.4]; } })();
const LOSS_MIN_NOTIONAL      = Number(E('LOSS_MIN_NOTIONAL', 5));

// Daily reset / cap
const DAILY_PNL_CAP_USDT   = Number(E('DAILY_PNL_CAP_USDT', 0)); // 0 = off
const DAILY_RESET_HOUR_UTC = Number(E('DAILY_RESET_HOUR_UTC', 0));

// Optional HMAC for extra verification
const HMAC_ENABLED = String(E('HMAC_ENABLED','false')).toLowerCase()==='true';
const HMAC_SECRET  = E('HMAC_SECRET','');
const HMAC_HEADER  = E('HMAC_HEADER','X-Signature');

// Paper mode fee assumption (perc. of notional, e.g. 0.04% taker)
const PAPER_FEE_PCT = Number(E('PAPER_FEE_PCT', 0.04));

// CORS for Netlify/other dashboard origins (default allow all)
const NETLIFY_ORIGIN = E('NETLIFY_ORIGIN','*');
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', NETLIFY_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Token, X-Webhook-Secret, ' + HMAC_HEADER);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- CCXT MEXC
const mexc = new ccxt.mexc({
  apiKey: E('MEXC_KEY',''),
  secret: E('MEXC_SECRET',''),
  enableRateLimit: true,
  options: { defaultType: 'swap' }
});

// ---- Optimizer (OpenRouter)
const OPENROUTER_API_KEY = E('OPENROUTER_API_KEY', '');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = E('OPENROUTER_MODEL', 'openrouter/auto');

// ---- State
const now = () => Date.now();
const tradeTimes = [];             // timestamps (ms) of executions for hourly rate-limit
const cooldownUntil = new Map();   // symbol -> ts(ms)
const lossStreak    = new Map();   // symbol -> count
const haltedUntil   = new Map();   // symbol -> 0 (manual) | ts(ms)
const lastSpread    = new Map();   // symbol -> pct
const fills         = [];          // trade fills (realized pnl tracked)
const events        = [];          // text logs for /logs.csv and SSE stream
const daily = { key: '', pnl: 0, trades: 0 };

// Inventory for realized pnl calc from executed fills
const inv = new Map(); // symbol -> { pos, avg }

let GLOBAL_HALT = false;

// ---- SSE
const sseClients = new Set();
function sseEmit(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients) { try { c.res.write(msg); } catch {} }
}

// ---- Utilities
function log(s) {
  const e = `[${new Date().toISOString()}] ${s}`;
  events.push(e);
  if (events.length > 2000) events.splice(0, events.length - 2000);
  try { sseEmit('log', { ts: Date.now(), line: s }); } catch {}
}

function pruneHour() {
  const cut = now() - 3600 * 1000;
  while (tradeTimes.length && tradeTimes[0] < cut) tradeTimes.shift();
}

function startBucket() {
  const d = new Date();
  const h = DAILY_RESET_HOUR_UTC;
  const b = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0, 0));
  if (d.getUTCHours() < h) b.setUTCDate(b.getUTCDate() - 1);
  return b;
}

function ensureBucket() {
  const key = startBucket().toISOString().slice(0,10) + `@${DAILY_RESET_HOUR_UTC}`;
  if (daily.key !== key) {
    daily.key = key; daily.pnl = 0; daily.trades = 0;
    fills.length = 0; inv.clear(); lossStreak.clear(); haltedUntil.clear(); lastSpread.clear();
    log('Daily reset ' + key);
  }
}

function requireAdmin(req, res) {
  const url = new URL(req.protocol+'://'+req.get('host')+req.originalUrl);
  const ok = !DASHBOARD_TOKEN
    || req.get('X-Dashboard-Token') === DASHBOARD_TOKEN
    || url.searchParams.get('token') === DASHBOARD_TOKEN;
  if (!ok) { res.status(401).json({ ok:false, error:'unauthorized' }); return false; }
  return true;
}

function verify(req) {
  const basic = SECRET && (req.get('X-Webhook-Secret')===SECRET ||
                (new URL(req.protocol+'://'+req.get('host')+req.originalUrl)).searchParams.get('secret')===SECRET);
  if (!HMAC_ENABLED) return basic || !SECRET;
  const sig = req.get(HMAC_HEADER) || '';
  const mac = crypto.createHmac('sha256', HMAC_SECRET).update(rawBody||Buffer.from('')).digest('hex');
  return basic || (sig && sig === mac);
}

async function spreadPct(sym) {
  const ob = await mexc.fetchOrderBook(sym, 5).catch(()=>null);
  if (!ob || !ob.bids?.length || !ob.asks?.length) {
    if (REJECT_IF_THIN_BOOK) throw new Error('thin_book');
    return Infinity;
  }
  const bid = ob.bids[0][0], ask = ob.asks[0][0];
  const pct = ((ask - bid) / ((ask + bid) / 2)) * 100;
  lastSpread.set(sym, pct);
  return pct;
}

async function notionalToAmount(sym, usdt) {
  const t = await mexc.fetchTicker(sym).catch(()=>null);
  const px = t?.last || Number(t?.info?.lastPrice) || 0;
  if (!px) throw new Error('no_price');
  return Number(mexc.amountToPrecision(sym, usdt / px));
}

async function ensureLev(sym, lev) {
  try {
    if (!DRY) {
      await mexc.setLeverage(lev, sym, { marginMode: DEFAULT_ISOLATED ? 'isolated' : 'cross' });
      if (DEFAULT_ISOLATED) await mexc.setMarginMode('isolated', sym);
    }
  } catch(e){ log('Leverage set warn: ' + (e?.message || e)); }
}

function isHalted(sym) {
  if (GLOBAL_HALT) return true;
  const u = haltedUntil.get(sym);
  if (u === undefined) return false;
  if (u === 0) return true;
  if (now() >= u) { haltedUntil.delete(sym); lossStreak.set(sym, 0); return false; }
  return true;
}

function reducedNotional(sym, base) {
  const s = (lossStreak.get(sym) || 0);
  const idx = Math.min(s, Math.max(0, LOSS_REDUCE_FACTORS.length - 1));
  const f = Number(LOSS_REDUCE_FACTORS[idx] || 1);
  return Math.max(LOSS_MIN_NOTIONAL, base * f);
}

// Mark a fill and compute realized pnl against inventory
function markFill(sym, side, price, amount, fee) {
  if (!inv.has(sym)) inv.set(sym, { pos:0, avg:0 });
  const st = inv.get(sym);
  let realized = -(fee || 0);
  const signed = (side === 'buy' ? 1 : -1) * amount;

  // Same direction -> average
  if ((st.pos >= 0 && signed > 0) || (st.pos <= 0 && signed < 0)) {
    const newPos = st.pos + signed;
    if (Math.sign(st.pos) === Math.sign(newPos) || st.pos === 0) {
      const notOld = Math.abs(st.pos) * st.avg;
      const notAdd = Math.abs(signed) * price;
      const newAbs = Math.abs(newPos);
      st.avg = newAbs ? (notOld + notAdd) / newAbs : 0;
      st.pos = newPos;
      inv.set(sym, st);
      fills.push({ ts: now(), symbol: sym, side, price, amount, fee, realized });
      sseEmit('fill', { ts: now(), symbol: sym, side, price, amount, fee, realized });
      return realized;
    }
  }

  // Closing / flipping
  if ((st.pos > 0 && signed < 0) || (st.pos < 0 && signed > 0)) {
    let rem = Math.abs(signed);
    while (rem > 0 && st.pos !== 0) {
      const closable = Math.min(Math.abs(st.pos), rem);
      const dir = st.pos > 0 ? 1 : -1;
      const pnlPer = dir === 1 ? (price - st.avg) : (st.avg - price);
      realized += pnlPer * closable;
      st.pos += -dir * closable;
      rem -= closable;
      if (st.pos === 0) st.avg = 0;
    }
    if (rem > 0) {
      const ns = (signed > 0 ? 1 : -1) * rem;
      const notOld = Math.abs(st.pos) * st.avg;
      const notAdd = Math.abs(ns) * price;
      const newAbs = Math.abs(st.pos + ns);
      st.avg = newAbs ? (notOld + notAdd) / newAbs : 0;
      st.pos = st.pos + ns;
    }
    inv.set(sym, st);
  }

  fills.push({ ts: now(), symbol: sym, side, price, amount, fee, realized });
  daily.pnl += realized;

  if (realized < 0) {
    lossStreak.set(sym, (lossStreak.get(sym)||0) + 1);
    if (COOLDOWN_AFTER_LOSS_SEC > 0) cooldownUntil.set(sym, now() + COOLDOWN_AFTER_LOSS_SEC * 1000);
    if (MAX_CONSEC_LOSSES > 0 && (lossStreak.get(sym)||0) >= MAX_CONSEC_LOSSES) {
      haltedUntil.set(sym, LOSS_HALT_COOLDOWN_MIN > 0 ? now() + LOSS_HALT_COOLDOWN_MIN * 60 * 1000 : 0);
    }
  } else if (realized > 0) {
    lossStreak.set(sym, 0);
  }

  if (fills.length > 5000) fills.splice(0, fills.length - 5000);
  sseEmit('fill', { ts: now(), symbol: sym, side, price, amount, fee, realized });
}

// ---- Static
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const ok = !DASHBOARD_TOKEN || req.get('X-Dashboard-Token') === DASHBOARD_TOKEN ||
             (new URL(req.protocol+'://'+req.get('host')+req.originalUrl)).searchParams?.get('token') === DASHBOARD_TOKEN;
  if (!ok) return res.status(401).send('<h3>Unauthorized</h3>');
  res.set('content-type', 'text/html; charset=utf-8')
     .sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- SSE
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders?.();
  const client = { res };
  sseClients.add(client);
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, ts: Date.now() })}\n\n`);
  req.on('close', () => sseClients.delete(client));
});

// ---- APIs
app.get('/health', (req, res) => {
  ensureBucket();
  pruneHour();

  const cd = {};
  for (const [s, t] of cooldownUntil.entries()) {
    const left = Math.max(0, Math.round((t - now())/1000));
    if (left > 0) cd[s] = left; else cooldownUntil.delete(s);
  }

  const halted = {};
  for (const [s, t] of haltedUntil.entries()) {
    halted[s] = t === 0 ? 'manual' : Math.max(0, Math.round((t-now())/1000)) + 's';
  }

  res.json({
    ok: true,
    dry: DRY,
    globalHalt: GLOBAL_HALT,
    dailyKey: daily.key,
    tradesToday: daily.trades,
    pnlToday: Number(daily.pnl.toFixed(6)),
    tradesLastHour: tradeTimes.length,
    cooldown: cd,
    halted,
    lastSpreadPct: Object.fromEntries([...lastSpread.entries()].map(([s, v])=>[s, Number(v.toFixed(4))]))
  });
});

app.get('/config', (req,res)=>{
  res.json({
    ok:true, dry:DRY,
    defaults:{ DEFAULT_SYMBOL, DEFAULT_NOTIONAL, DEFAULT_LEVERAGE, DEFAULT_ISOLATED },
    guards:{ MAX_TRADES_PER_HOUR, MAX_SPREAD_PCT, REJECT_IF_THIN_BOOK, COOLDOWN_AFTER_LOSS_SEC },
    loss:{ MAX_CONSEC_LOSSES, LOSS_HALT_COOLDOWN_MIN, LOSS_REDUCE_FACTORS, LOSS_MIN_NOTIONAL },
    pnl:{ DAILY_PNL_CAP_USDT, DAILY_RESET_HOUR_UTC }
  });
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
  for (const e of events) res.write(`${e.slice(1,25)},${e.replace(/^[^\]]+\]\s*/,'').replace(/,/g,';')}\n`);
  res.end();
});

// JSON endpoints for frontend
app.get('/fills', (req, res) => {
  res.json({ ok:true, fills });
});
app.get('/logs', (req, res) => {
  res.json({ ok:true, logs: events.slice(-500) });
});

app.get('/stats', (req, res) => {
  const rows = fills.map(f => ({
    ts: Number(f.ts),
    realized: Number(f.realized || 0),
    fee: Number(f.fee || 0),
    symbol: f.symbol,
    side: f.side,
    price: Number(f.price || 0),
    amount: Number(f.amount || 0)
  })).sort((a,b)=>a.ts-b.ts);

  let equity = [];
  let cum = 0;
  for (const r of rows) { cum += r.realized; equity.push({ ts: r.ts, equity: Number(cum.toFixed(8)) }); }

  let peak = -Infinity, ddSeries = [], maxDD = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.equity);
    const dd = p.equity - peak;
    maxDD = Math.min(maxDD, dd);
    ddSeries.push({ ts: p.ts, dd: Number(dd.toFixed(8)) });
  }

  let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0;
  for (const r of rows) {
    if (r.realized > 0) { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin); }
    else if (r.realized < 0) { curLoss++; curWin = 0; maxLoss = Math.max(maxLoss, curLoss); }
  }

  const wins   = rows.filter(r => r.realized >  0);
  const losses = rows.filter(r => r.realized <  0);
  const grossProfit = wins.reduce((a,b)=>a+b.realized, 0);
  const grossLoss   = losses.reduce((a,b)=>a+b.realized, 0);
  const netPnl      = Number((grossProfit + grossLoss).toFixed(8));
  const winRate     = rows.length ? wins.length / rows.length : 0;
  const avgWin      = wins.length   ? grossProfit / wins.length      : 0;
  const avgLossAbs  = losses.length ? Math.abs(grossLoss / losses.length) : 0;
  const profitFactor = (Math.abs(grossLoss) > 1e-12) ? (grossProfit / Math.abs(grossLoss)) : (grossProfit > 0 ? 9999 : 0);
  const expectancy   = (wins.length || losses.length) ? (winRate * avgWin) - ((1 - winRate) * avgLossAbs) : 0;

  const edges = [-Infinity, -5, -3, -2, -1, -0.5, -0.2, -0.1, 0, 0.1, 0.2, 0.5, 1, 2, 3, 5, Infinity];
  const labels = ["<-5","-5..-3","-3..-2","-2..-1","-1..-0.5","-0.5..-0.2","-0.2..-0.1","-0.1..0","0..0.1","0.1..0.2","0.2..0.5","0.5..1","1..2","2..3","3..5",">5"];
  const bins = new Array(labels.length).fill(0);
  for (const r of rows){
    let idx = edges.findIndex((e,i)=> r.realized >= edges[i] && r.realized < edges[i+1]);
    if (idx === -1) idx = labels.length - 1;
    bins[idx] += 1;
  }

  const lastEvents = events.slice(-25);

  res.json({
    ok: true,
    dry: DRY,
    dailyKey: daily.key,
    counts: { trades: rows.length, wins: wins.length, losses: losses.length },
    pnl: {
      grossProfit: Number(grossProfit.toFixed(6)),
      grossLoss:   Number(grossLoss.toFixed(6)),
      net:         netPnl
    },
    quality: {
      winRate: Number((winRate*100).toFixed(2)),
      avgWin: Number(avgWin.toFixed(6)),
      avgLoss: Number(avgLossAbs.toFixed(6)),
      profitFactor: Number(profitFactor.toFixed(3)),
      expectancy: Number(expectancy.toFixed(6))
    },
    risk: { maxDrawdown: Number(maxDD.toFixed(6)) },
    streaks: { currentWins: curWin, currentLosses: curLoss, maxWins: maxWin, maxLosses: maxLoss },
    equity, drawdown: ddSeries, hist: { labels, bins }, lastEvents
  });
});

app.get('/stats/daily', (req, res) => {
  const rows = fills.map(f => ({
    ts: Number(f.ts),
    realized: Number(f.realized || 0),
    fee: Number(f.fee || 0),
    symbol: f.symbol
  })).sort((a,b)=>a.ts-b.ts);

  function dayKey(ts) {
    const d = new Date(ts);
    const ref = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DAILY_RESET_HOUR_UTC, 0, 0, 0));
    if (d.getUTCHours() < DAILY_RESET_HOUR_UTC) ref.setUTCDate(ref.getUTCDate() - 1);
    return ref.toISOString().slice(0,10) + '@' + DAILY_RESET_HOUR_UTC;
  }

  const map = new Map();
  for (const r of rows) {
    const key = dayKey(r.ts);
    if (!map.has(key)) map.set(key, { trades:0, wins:0, losses:0, grossP:0, grossL:0, net:0, startTs:r.ts, endTs:r.ts });
    const d = map.get(key);
    d.trades++;
    if (r.realized > 0){ d.wins++;  d.grossP += r.realized; }
    if (r.realized < 0){ d.losses++; d.grossL += r.realized; }
    d.net += r.realized;
    d.endTs = r.ts;
  }

  const days = [...map.entries()].map(([key,d])=>{
    const winRate = d.trades ? (d.wins/d.trades)*100 : 0;
    const pf = Math.abs(d.grossL) > 1e-12 ? (d.grossP/Math.abs(d.grossL)) : (d.grossP > 0 ? 9999 : 0);
    return {
      key,
      startIso: new Date(d.startTs).toISOString(),
      endIso: new Date(d.endTs).toISOString(),
      trades: d.trades,
      wins: d.wins,
      losses: d.losses,
      winRate: Number(winRate.toFixed(2)),
      profitFactor: Number(pf.toFixed(3)),
      grossProfit: Number(d.grossP.toFixed(6)),
      grossLoss: Number(d.grossL.toFixed(6)),
      net: Number(d.net.toFixed(6))
    };
  }).sort((a,b)=>a.startIso.localeCompare(b.startIso));

  res.json({ ok:true, daily: days });
});

// ---- Admin
app.post('/admin/halt', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const s=(req.body?.symbol||DEFAULT_SYMBOL).toUpperCase();
  haltedUntil.set(s, 0);
  log('HALT ' + s);
  res.json({ ok:true, halted:s });
});

app.post('/admin/unhalt', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const s=(req.body?.symbol||DEFAULT_SYMBOL).toUpperCase();
  haltedUntil.delete(s);
  lossStreak.set(s,0);
  log('UNHALT ' + s);
  res.json({ ok:true, unhalted:s });
});

app.post('/admin/cooldown', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const s=(req.body?.symbol||DEFAULT_SYMBOL).toUpperCase();
  const sec=Number(req.body?.seconds||60);
  cooldownUntil.set(s, now()+sec*1000);
  log(`COOLDOWN ${s} ${sec}s`);
  res.json({ ok:true, cooldown:{ symbol:s, seconds:sec } });
});

app.post('/admin/halt_all', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  GLOBAL_HALT=true;
  log('MASTER HALT enabled');
  res.json({ ok:true, globalHalt: GLOBAL_HALT });
});

app.post('/admin/unhalt_all', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  GLOBAL_HALT=false;
  log('MASTER HALT disabled');
  res.json({ ok:true, globalHalt: GLOBAL_HALT });
});

app.post('/admin/reset', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  fills.length=0; inv.clear(); daily.pnl=0; daily.trades=0;
  lossStreak.clear(); cooldownUntil.clear(); haltedUntil.clear(); lastSpread.clear();
  log('RESET: cleared fills, inventory, daily counters');
  res.json({ ok:true, reset:true });
});

app.post('/admin/toggle_dry', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  if (typeof req.body?.dry !== 'undefined') {
    DRY = String(req.body.dry).toLowerCase() === 'true';
  } else {
    DRY = !DRY;
  }
  log(`DRY set to ${DRY}`);
  res.json({ ok:true, dry: DRY });
});

// ---- Webhook
app.post('/webhook', async (req,res)=>{
  try{
    if (!verify(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
    ensureBucket();

    if (DAILY_PNL_CAP_USDT > 0 && daily.pnl >= DAILY_PNL_CAP_USDT) {
      log(`DAILY CAP reached: ${daily.pnl.toFixed(4)} USDT`);
      return res.status(423).json({ ok:false, error:'daily_cap' });
    }

    const b = req.body || {};
    const signal = String(b.signal || '').toUpperCase();
    const rawSymbol = (b.symbol || DEFAULT_SYMBOL).toUpperCase();
    const symbol = rawSymbol.includes('/') ? rawSymbol : DEFAULT_SYMBOL;
    const lev = Number(b.leverage || DEFAULT_LEVERAGE);
    const baseNotional = Number(b.notional || DEFAULT_NOTIONAL);
    const relayTimer = Boolean(b.relayTimer);
    const autoCloseSec = Number(b.autoCloseSec || 0);

    if (!['LONG','SHORT','CLOSE_LONG','CLOSE_SHORT'].includes(signal)) {
      return res.status(400).json({ ok:false, error:'bad_signal' });
    }
    if (isHalted(symbol)) return res.status(423).json({ ok:false, error:'halted' });

    pruneHour();
    if (tradeTimes.length >= MAX_TRADES_PER_HOUR) return res.status(429).json({ ok:false, error:'rate_limited' });

    const sp = await spreadPct(symbol);
    if (sp > MAX_SPREAD_PCT) return res.status(400).json({ ok:false, error:'wide_spread', spreadPct: sp });

    await ensureLev(symbol, lev);
    const notional = reducedNotional(symbol, baseNotional);
    const amt = await notionalToAmount(symbol, notional);

    // Record exec for feeds/stats
    tradeTimes.push(now());
    daily.trades += 1;
    log(`EXEC ${signal} ${symbol} notional=${notional} lev=${lev}`);
    sseEmit('exec', { ts: now(), symbol, signal, lev, notionalUSDT: notional });

    // ---- LIVE: send orders to exchange
    if (!DRY){
      if (signal==='LONG')        await mexc.createMarketBuyOrder(symbol, amt);
      else if (signal==='SHORT')  await mexc.createMarketSellOrder(symbol, amt);
      else if (signal==='CLOSE_LONG')  await mexc.createMarketSellOrder(symbol, amt);
      else if (signal==='CLOSE_SHORT') await mexc.createMarketBuyOrder(symbol, amt);
    } else {
      // ---- PAPER: simulate fills so dashboard updates
      const t = await mexc.fetchTicker(symbol).catch(()=>null);
      const px = t?.last || Number(t?.info?.lastPrice) || 0;
      const feeUSDT = (notional * PAPER_FEE_PCT) / 100; // convert pct → fraction
      if (px > 0) {
        if (signal==='LONG' || signal==='CLOSE_SHORT') {
          markFill(symbol, 'buy',  px, amt, feeUSDT);
        } else if (signal==='SHORT' || signal==='CLOSE_LONG') {
          markFill(symbol, 'sell', px, amt, feeUSDT);
        }
      }
    }

    // Optional timed auto-close (LIVE only; paper already marked a fill)
    if (!DRY && relayTimer && autoCloseSec > 0 &&
       (signal === 'LONG' || signal === 'SHORT')) {
      setTimeout(async () => {
        try {
          const t2 = await mexc.fetchTicker(symbol).catch(() => null);
          const px2 = t2?.last || Number(t2?.info?.lastPrice) || 0;
          const amt2 = await notionalToAmount(symbol, notional);
          if (px2 > 0) {
            if (signal === 'LONG') {
              await mexc.createMarketSellOrder(symbol, amt2);
              log(`[autoClose] CLOSED LONG ${symbol} @ ${px2}`);
            } else if (signal === 'SHORT') {
              await mexc.createMarketBuyOrder(symbol, amt2);
              log(`[autoClose] CLOSED SHORT ${symbol} @ ${px2}`);
            }
          }
        } catch (e) {
          log('autoClose error: ' + (e?.message || e));
        }
      }, autoCloseSec * 1000);
    }

    res.json({ ok:true, dry:DRY, symbol, signal, lev, notionalUSDT:notional, autoCloseSec, spreadPct: sp });
  } catch(e){
    console.error('webhook error', e);
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// ---- Optimizer (OpenRouter GPT-5) — returns a JSON suggestion
app.post('/optimizer/suggest', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!OPENROUTER_API_KEY) return res.status(400).json({ ok:false, error:'OPENROUTER_API_KEY not set' });

    const prompt = `
You are an automated strategy optimizer for a MEXC scalper (futures).
Goal: improve net profit while controlling max drawdown.
Return STRICT JSON with keys: minSignals, indicators, risk, execution. No commentary.

Constraints:
- minSignals must be 3 or 4
- indicators may adjust: rsiLen (7..21), rsiBuy (50..65), rsiSell (35..50),
  bbLen (10..40), bbDev (1.6..3.5), emaFast (5..21), emaSlow (30..100), atrLen (7..21), atrMult (0.8..3.0)
- risk: leverage (1..125), notionalUSDT (5..200), cooldownSec (0..600)
- execution: maxSpreadPct (0.01..0.15), maxTradesPerHour (5..200)

Current:
${JSON.stringify({
  dry: DRY,
  defaults: { DEFAULT_SYMBOL, DEFAULT_NOTIONAL, DEFAULT_LEVERAGE, DEFAULT_ISOLATED },
  guards: { MAX_TRADES_PER_HOUR, MAX_SPREAD_PCT, REJECT_IF_THIN_BOOK, COOLDOWN_AFTER_LOSS_SEC },
  loss: { MAX_CONSEC_LOSSES, LOSS_HALT_COOLDOWN_MIN, LOSS_REDUCE_FACTORS, LOSS_MIN_NOTIONAL }
})}
`.trim();

    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: 'You are a disciplined quantitative trading assistant.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ ok:false, error:'openrouter_error', detail: t.slice(0,500) });
    }
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    let suggestion;
    try { suggestion = JSON.parse(text); }
    catch { return res.status(500).json({ ok:false, error:'bad_optimizer_json', raw: text }); }

    return res.json({ ok:true, suggestion });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// ---- Background fill sync (real fills when API keys are present)
async function pollFills(){
  try{
    ensureBucket();
    const symbols = new Set([DEFAULT_SYMBOL]); // extend with more if needed
    for (const s of symbols){
      const trades = await mexc.fetchMyTrades(s, undefined, 100).catch(()=>[]);
      for (const t of trades){
        const id = `${t.id}:${t.symbol}`;
        if (fills.find(x=>x.id===id)) continue;
        const fee = (t.fee && t.fee.cost && (t.fee.currency||'').toUpperCase()==='USDT') ? Number(t.fee.cost) : 0;
        const side = (t.side||'').toLowerCase();
        const price = Number(t.price);
        const amount = Math.abs(Number(t.amount));
        markFill(t.symbol, side, price, amount, fee);
        fills[fills.length-1].id = id;
      }
      if (fills.length > 5000) fills.splice(0, fills.length-5000);
    }
  }catch(e){ /* ignore */ }
}
setInterval(pollFills, 15000);

// ---- Start
app.listen(PORT, '0.0.0.0', () =>
  console.log(`[relay] listening on 0.0.0.0:${PORT}, DRY_RUN=${DRY}`)
);
