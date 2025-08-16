// server.js  — drop-in full file
import 'dotenv/config';
import express from 'express';
import ccxt from 'ccxt';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();

// ---------- helpers / env ----------
const E = (k, d = null) => process.env[k] ?? d;

const PORT = Number(E('PORT', 8080));
const DRY = String(E('DRY_RUN', 'true')).toLowerCase() === 'true';

const SECRET = E('WEBHOOK_SECRET', '');
const DASHBOARD_TOKEN = E('DASHBOARD_TOKEN', '');

const DEFAULT_SYMBOL = String(E('DEFAULT_SYMBOL', 'BTC/USDT:USDT')).toUpperCase();
const DEFAULT_NOTIONAL = Number(E('DEFAULT_NOTIONAL_USDT', 20));
const DEFAULT_LEVERAGE = Number(E('DEFAULT_LEVERAGE', 100));
const DEFAULT_ISOLATED = String(E('DEFAULT_ISOLATED', 'true')).toLowerCase() === 'true';

const MAX_TRADES_PER_HOUR = Number(E('MAX_TRADES_PER_HOUR', 60));
const MAX_SPREAD_PCT = Number(E('MAX_SPREAD_PCT', 0.03));
const REJECT_IF_THIN_BOOK = String(E('REJECT_IF_THIN_BOOK', 'true')).toLowerCase() === 'true';
const COOLDOWN_AFTER_LOSS_SEC = Number(E('COOLDOWN_AFTER_LOSS_SEC', 120));

const MAX_CONSEC_LOSSES = Number(E('MAX_CONSEC_LOSSES', 3));
const LOSS_HALT_COOLDOWN_MIN = Number(E('LOSS_HALT_COOLDOWN_MIN', 10));
const LOSS_REDUCE_FACTORS = (() => {
  try { return JSON.parse(E('LOSS_REDUCE_FACTORS', '[1.0,0.7,0.4]')); } catch { return [1.0, 0.7, 0.4]; }
})();
const LOSS_MIN_NOTIONAL = Number(E('LOSS_MIN_NOTIONAL', 5));

const DAILY_PNL_CAP_USDT = Number(E('DAILY_PNL_CAP_USDT', 0));
const DAILY_RESET_HOUR_UTC = Number(E('DAILY_RESET_HOUR_UTC', 0));

const HMAC_ENABLED = String(E('HMAC_ENABLED', 'false')).toLowerCase() === 'true';
const HMAC_SECRET = E('HMAC_SECRET', '');
const HMAC_HEADER = E('HMAC_HEADER', 'X-Signature');

// ---------- CORS / raw body (for HMAC) ----------
let raw = Buffer.alloc(0);
app.use((req, res, next) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    raw = Buffer.concat(chunks);
    try { req.body = JSON.parse(raw.toString('utf8') || '{}'); } catch { req.body = {}; }
    next();
  });
});
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // front-end can live on Netlify if you want
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Token, X-Webhook-Secret, ' + HMAC_HEADER);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- exchange ----------
const mexc = new ccxt.mexc({
  apiKey: E('MEXC_KEY', ''),
  secret: E('MEXC_SECRET', ''),
  enableRateLimit: true,
  options: { defaultType: 'swap' }
});

// ---------- state ----------
const now = () => Date.now();
const tradeTimes = [];
const cooldownUntil = new Map();
const lossStreak = new Map();
const haltedUntil = new Map();
const lastSpread = new Map();
const daily = { key: '', pnl: 0, trades: 0 };
const inv = new Map();
const fills = [];
const events = [];
let GLOBAL_HALT = false;

// ---------- utils ----------
function log(s) {
  const e = `[${new Date().toISOString()}] ${s}`;
  events.push(e);
  if (events.length > 2000) events.splice(0, events.length - 2000);
}
function pruneHour(arr) {
  const cut = now() - 3600 * 1000;
  while (arr.length && arr[0] < cut) arr.shift();
}
function startBucket() {
  const d = new Date(); const h = DAILY_RESET_HOUR_UTC;
  const b = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0, 0));
  if (d.getUTCHours() < h) b.setUTCDate(b.getUTCDate() - 1);
  return b;
}
function ensureBucket() {
  const key = startBucket().toISOString().slice(0, 10) + `@${DAILY_RESET_HOUR_UTC}`;
  if (daily.key !== key) {
    daily.key = key; daily.pnl = 0; daily.trades = 0;
    fills.length = 0; inv.clear(); lossStreak.clear(); haltedUntil.clear();
    log('Daily reset ' + key);
  }
}
function requireAdmin(req, res) {
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  const ok = !DASHBOARD_TOKEN
    || req.get('X-Dashboard-Token') === DASHBOARD_TOKEN
    || url.searchParams.get('token') === DASHBOARD_TOKEN;
  if (!ok) { res.status(401).json({ ok: false, error: 'unauthorized' }); return false; }
  return true;
}
function verify(req) {
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  const basic = SECRET && (req.get('X-Webhook-Secret') === SECRET || url.searchParams.get('secret') === SECRET);
  if (!HMAC_ENABLED) return basic || !SECRET;
  const sig = req.get(HMAC_HEADER) || '';
  const mac = crypto.createHmac('sha256', HMAC_SECRET).update(raw || Buffer.from('')).digest('hex');
  return basic || (sig && sig === mac);
}
async function spreadPct(sym) {
  const ob = await mexc.fetchOrderBook(sym, 5).catch(() => null);
  if (!ob || !ob.bids?.length || !ob.asks?.length) {
    if (REJECT_IF_THIN_BOOK) throw new Error('thin_book');
    return Infinity;
  }
  const bid = ob.bids[0][0], ask = ob.asks[0][0];
  const pct = ((ask - bid) / ((ask + bid) / 2)) * 100; lastSpread.set(sym, pct); return pct;
}
async function notionalToAmount(sym, usdt) {
  const t = await mexc.fetchTicker(sym).catch(() => null);
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
  } catch (e) { log('Leverage set warn: ' + (e?.message || e)); }
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
function markFill(sym, side, price, amount, fee) {
  if (!inv.has(sym)) inv.set(sym, { pos: 0, avg: 0 });
  const st = inv.get(sym);
  let realized = -(fee || 0);
  const signed = (side === 'buy' ? 1 : -1) * amount;

  // add/increase
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
      return realized;
    }
  }
  // close/flip
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
    lossStreak.set(sym, (lossStreak.get(sym) || 0) + 1);
    if (COOLDOWN_AFTER_LOSS_SEC > 0) cooldownUntil.set(sym, now() + COOLDOWN_AFTER_LOSS_SEC * 1000);
    if (MAX_CONSEC_LOSSES > 0 && (lossStreak.get(sym) || 0) >= MAX_CONSEC_LOSSES) {
      haltedUntil.set(sym, LOSS_HALT_COOLDOWN_MIN > 0 ? now() + LOSS_HALT_COOLDOWN_MIN * 60 * 1000 : 0);
    }
  } else if (realized > 0) {
    lossStreak.set(sym, 0);
  }
  if (fills.length > 5000) fills.splice(0, fills.length - 5000);
}

// ---------- static frontend (this is the fix) ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  // optional dashboard auth
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  const ok = !DASHBOARD_TOKEN
    || req.get('X-Dashboard-Token') === DASHBOARD_TOKEN
    || url.searchParams.get('token') === DASHBOARD_TOKEN;

  if (!ok) return res.status(401).send('<h3>Unauthorized</h3>');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- API ----------
app.get('/health', (req, res) => {
  ensureBucket(); pruneHour(tradeTimes);
  const cd = {};
  for (const [s, t] of cooldownUntil.entries()) {
    const left = Math.max(0, Math.round((t - now()) / 1000));
    if (left > 0) cd[s] = left; else cooldownUntil.delete(s);
  }
  const halted = {};
  for (const [s, t] of haltedUntil.entries()) halted[s] = t === 0 ? 'manual' : Math.max(0, Math.round((t - now()) / 1000)) + 's';
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
    lastSpreadPct: Object.fromEntries([...lastSpread.entries()].map(([s, v]) => [s, Number(v.toFixed(4))]))
  });
});

app.get('/config', (req, res) => {
  res.json({
    ok: true,
    dry: DRY,
    defaults: { DEFAULT_SYMBOL, DEFAULT_NOTIONAL, DEFAULT_LEVERAGE, DEFAULT_ISOLATED },
    guards: { MAX_TRADES_PER_HOUR, MAX_SPREAD_PCT, REJECT_IF_THIN_BOOK, COOLDOWN_AFTER_LOSS_SEC },
    loss: { MAX_CONSEC_LOSSES, LOSS_HALT_COOLDOWN_MIN, LOSS_REDUCE_FACTORS, LOSS_MIN_NOTIONAL },
    pnl: { DAILY_PNL_CAP_USDT, DAILY_RESET_HOUR_UTC }
  });
});

app.get('/pnl.csv', (req, res) => {
  ensureBucket();
  res.set('content-type', 'text/csv; charset=utf-8');
  res.write('ts_iso,symbol,side,price,amount,fee_usdt,realized_usdt\n');
  for (const f of fills) res.write(`${new Date(f.ts).toISOString()},${f.symbol},${f.side},${f.price},${f.amount},${(f.fee || 0).toFixed(6)},${(f.realized || 0).toFixed(6)}\n`);
  res.end();
});

app.get('/logs.csv', (req, res) => {
  res.set('content-type', 'text/csv; charset=utf-8');
  res.write('ts_iso,event\n');
  for (const e of events) res.write(`${e.slice(1, 25)},${e.replace(/^[^\]]+\]\s*/, '').replace(/,/g, ';')}\n`);
  res.end();
});

// basic stats for dashboard
app.get('/stats', (req, res) => {
  const rows = fills.map(f => ({
    ts: +f.ts, realized: +(f.realized || 0), fee: +(f.fee || 0),
    symbol: f.symbol, side: f.side, price: +(f.price || 0), amount: +(f.amount || 0)
  })).sort((a, b) => a.ts - b.ts);

  let equity = [], cum = 0;
  for (const r of rows) { cum += r.realized; equity.push({ ts: r.ts, equity: +cum.toFixed(8) }); }

  let peak = -Infinity, ddSeries = [], maxDD = 0;
  for (const p of equity) { peak = Math.max(peak, p.equity); const dd = p.equity - peak; maxDD = Math.min(maxDD, dd); ddSeries.push({ ts: p.ts, dd: +dd.toFixed(8) }); }

  let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0;
  for (const r of rows) {
    if (r.realized > 0) { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin); }
    else if (r.realized < 0) { curLoss++; curWin = 0; maxLoss = Math.max(maxLoss, curLoss); }
  }
  const wins = rows.filter(r => r.realized > 0);
  const losses = rows.filter(r => r.realized < 0);
  const grossProfit = wins.reduce((a, b) => a + b.realized, 0);
  const grossLoss = losses.reduce((a, b) => a + b.realized, 0);
  const netPnl = +(grossProfit + grossLoss).toFixed(8);
  const winRate = rows.length ? wins.length / rows.length : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLossAbs = losses.length ? Math.abs(grossLoss / losses.length) : 0;
  const profitFactor = (Math.abs(grossLoss) > 1e-12) ? (grossProfit / Math.abs(grossLoss)) : (grossProfit > 0 ? 9999 : 0);
  const expectancy = (wins.length || losses.length) ? (winRate * avgWin) - ((1 - winRate) * avgLossAbs) : 0;

  res.json({
    ok: true,
    dry: DRY,
    dailyKey: daily.key,
    counts: { trades: rows.length, wins: wins.length, losses: losses.length },
    pnl: { grossProfit: +grossProfit.toFixed(6), grossLoss: +grossLoss.toFixed(6), net: netPnl },
    quality: {
      winRate: +(winRate * 100).toFixed(2),
      avgWin: +avgWin.toFixed(6),
      avgLoss: +avgLossAbs.toFixed(6),
      profitFactor: +profitFactor.toFixed(3),
      expectancy: +expectancy.toFixed(6)
    },
    risk: { maxDrawdown: +maxDD.toFixed(6) },
    equity,
    drawdown: ddSeries,
    lastEvents: events.slice(-25),
  });
});

// admin
app.post('/admin/halt', (req, res) => { if (!requireAdmin(req, res)) return; const s = DEFAULT_SYMBOL; haltedUntil.set(s, 0); log('HALT ' + s); res.json({ ok: true, halted: s }); });
app.post('/admin/unhalt', (req, res) => { if (!requireAdmin(req, res)) return; const s = DEFAULT_SYMBOL; haltedUntil.delete(s); lossStreak.set(s, 0); log('UNHALT ' + s); res.json({ ok: true, unhalted: s }); });
app.post('/admin/cooldown', (req, res) => { if (!requireAdmin(req, res)) return; const s = DEFAULT_SYMBOL; const sec = 60; cooldownUntil.set(s, now() + sec * 1000); log(`COOLDOWN ${s} ${sec}s`); res.json({ ok: true }); });
app.post('/admin/halt_all', (req, res) => { if (!requireAdmin(req, res)) return; GLOBAL_HALT = true; log('MASTER HALT enabled'); res.json({ ok: true, globalHalt: GLOBAL_HALT }); });
app.post('/admin/unhalt_all', (req, res) => { if (!requireAdmin(req, res)) return; GLOBAL_HALT = false; log('MASTER HALT disabled'); res.json({ ok: true, globalHalt: GLOBAL_HALT }); });
app.post('/admin/reset', (req, res) => { if (!requireAdmin(req, res)) return; fills.length = 0; inv.clear(); daily.pnl = 0; daily.trades = 0; lossStreak.clear(); cooldownUntil.clear(); haltedUntil.clear(); lastSpread.clear(); log('RESET'); res.json({ ok: true }); });

// webhook
app.post('/webhook', async (req, res) => {
  try {
    if (!verify(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    ensureBucket();

    const b = req.body || {};
    const signal = String(b.signal || '').toUpperCase();
    const rawSymbol = String(b.symbol || DEFAULT_SYMBOL).toUpperCase();
    const symbol = rawSymbol.includes('/') ? rawSymbol : DEFAULT_SYMBOL;
    const lev = Number(b.leverage || DEFAULT_LEVERAGE);
    const baseNotional = Number(b.notional || DEFAULT_NOTIONAL);
    const relayTimer = Boolean(b.relayTimer);
    const autoCloseSec = Number(b.autoCloseSec || 0);

    if (isHalted(symbol)) return res.status(423).json({ ok: false, error: 'halted' });

    pruneHour(tradeTimes);
    if (tradeTimes.length >= MAX_TRADES_PER_HOUR) return res.status(429).json({ ok: false, error: 'rate_limited' });

    const sp = await spreadPct(symbol);
    if (sp > MAX_SPREAD_PCT) return res.status(400).json({ ok: false, error: 'wide_spread', spreadPct: sp });

    await ensureLev(symbol, lev);
    const notional = reducedNotional(symbol, baseNotional);
    const amt = await notionalToAmount(symbol, notional);

    if (!DRY) {
      if (signal === 'LONG') await mexc.createMarketBuyOrder(symbol, amt);
      else if (signal === 'SHORT') await mexc.createMarketSellOrder(symbol, amt);
      else if (signal === 'CLOSE_LONG') await mexc.createMarketSellOrder(symbol, amt);
      else if (signal === 'CLOSE_SHORT') await mexc.createMarketBuyOrder(symbol, amt);
      else return res.status(400).json({ ok: false, error: 'bad_signal' });
    }
    tradeTimes.push(now());
    daily.trades += 1;
    log(`EXEC ${signal} ${symbol} notional=${notional} lev=${lev}`);

    // optional auto-close
    if (!DRY && relayTimer && autoCloseSec > 0 && (signal === 'LONG' || signal === 'SHORT')) {
      setTimeout(async () => {
        try {
          const side = (signal === 'LONG') ? 'sell' : 'buy';
          const t = await mexc.fetchTicker(symbol).catch(() => null);
          const px = t?.last || Number(t?.info?.lastPrice) || 0;
          const fee = 0;
          if (side === 'buy') markFill(symbol, 'buy', px, amt, fee);
          else markFill(symbol, 'sell', px, amt, fee);
          if (signal === 'LONG') await mexc.createMarketSellOrder(symbol, amt);
          if (signal === 'SHORT') await mexc.createMarketBuyOrder(symbol, amt);
          log(`AUTO-CLOSE ${symbol} after ${autoCloseSec}s`);
        } catch (e) { log('auto-close error: ' + (e?.message || e)); }
      }, autoCloseSec * 1000);
    }

    res.json({ ok: true, dry: DRY, symbol, signal, lev, notionalUSDT: notional, autoCloseSec, spreadPct: sp });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// background fills sync
async function pollFills() {
  try {
    ensureBucket();
    const symbols = new Set([DEFAULT_SYMBOL]);
    for (const s of symbols) {
      const trades = await mexc.fetchMyTrades(s, undefined, 100).catch(() => []);
      for (const t of trades) {
        const id = `${t.id}:${t.symbol}`;
        if (fills.find(x => x.id === id)) continue;
        const fee = (t.fee && t.fee.cost && (t.fee.currency || '').toUpperCase() === 'USDT') ? Number(t.fee.cost) : 0;
        const side = (t.side || '').toLowerCase();
        const price = Number(t.price);
        const amount = Math.abs(Number(t.amount));
        markFill(t.symbol, side, price, amount, fee);
        fills[fills.length - 1].id = id;
      }
      if (fills.length > 5000) fills.splice(0, fills.length - 5000);
    }
  } catch { /* ignore */ }
}
setInterval(pollFills, 15000);

// start
app.listen(PORT, () => console.log(`[relay] listening on :${PORT}, DRY_RUN=${DRY}`));
