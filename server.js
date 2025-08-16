// server.js — no extra deps, no fake sim
import express from "express";
import { EventEmitter } from "events";

const app = express();

// ---- JSON body & raw capture (for future HMAC if you want) ----
app.use(express.json({ limit: "256kb" }));

// ---- minimal CORS (no 'cors' package required) ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Webhook-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- env & settings ----
const PORT = Number(process.env.PORT || 8080);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "yoursecret";
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() === "true";

// ---- in-memory state (no fake PnL) ----
let fills = [];   // {ts, symbol, side, price, amount, fee, realized}
let logs  = [];   // {ts,msg}
const events = new EventEmitter();

const stats = {
  dry: DRY_RUN,
  dailyKey: "",        // yyyy-mm-dd@hour
  tradesToday: 0,
  pnlToday: 0,
  tradesLastHour: 0,
  wins: 0,
  losses: 0,
  signals: []          // recent alert signals
};

// daily bucket key based on UTC midnight (or change hour if you wish)
const DAILY_RESET_HOUR_UTC = Number(process.env.DAILY_RESET_HOUR_UTC || 0);

function bucketKey(ts = Date.now()) {
  const d = new Date(ts);
  const ref = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DAILY_RESET_HOUR_UTC, 0, 0, 0));
  if (d.getUTCHours() < DAILY_RESET_HOUR_UTC) ref.setUTCDate(ref.getUTCDate() - 1);
  return ref.toISOString().slice(0,10) + "@" + DAILY_RESET_HOUR_UTC;
}

function ensureDaily() {
  const key = bucketKey();
  if (stats.dailyKey !== key) {
    stats.dailyKey = key;
    stats.tradesToday = 0;
    stats.pnlToday = 0;
    stats.tradesLastHour = 0;
    stats.wins = 0;
    stats.losses = 0;
    stats.signals = [];
    fills = [];
    logs.push({ ts: Date.now(), msg: "Daily reset "+key });
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  }
}

function logMsg(msg) {
  logs.push({ ts: Date.now(), msg });
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  try { events.emit("log", { ts: Date.now(), line: msg }); } catch {}
}

// ---- endpoints ----

// Health: quick glance status for the header badges
app.get("/health", (req, res) => {
  ensureDaily();
  res.json({
    ok: true,
    dry: DRY_RUN,
    dailyKey: stats.dailyKey,
    tradesToday: stats.tradesToday,
    pnlToday: Number(stats.pnlToday.toFixed(8)),
    tradesLastHour: stats.tradesLastHour
  });
});

// Main stats for dashboard widgets & charts
app.get("/stats", (req, res) => {
  ensureDaily();

  // equity/drawdown series from realized fills only (no fake data)
  let cum = 0;
  const rows = fills
    .map(f => ({ ts: f.ts, realized: Number(f.realized || 0) }))
    .sort((a,b)=>a.ts-b.ts);

  const equity = [];
  for (const r of rows) { cum += r.realized; equity.push({ ts: r.ts, equity: Number(cum.toFixed(8)) }); }

  let peak = -Infinity, maxDD = 0;
  const drawdown = equity.map(p => {
    peak = Math.max(peak, p.equity);
    const dd = p.equity - peak;           // negative or 0
    maxDD = Math.min(maxDD, dd);
    return { ts: p.ts, dd: Number(dd.toFixed(8)) };
  });

  // distribution bins (realized per trade)
  const labels = ["<-5","-5..-3","-3..-2","-2..-1","-1..-0.5","-0.5..-0.2","-0.2..-0.1","-0.1..0","0..0.1","0.1..0.2","0.2..0.5","0.5..1","1..2","2..3","3..5",">5"];
  const edges  = [-Infinity,-5,-3,-2,-1,-0.5,-0.2,-0.1,0,0.1,0.2,0.5,1,2,3,5,Infinity];
  const bins = new Array(labels.length).fill(0);
  for (const r of rows) {
    let idx = edges.findIndex((e,i)=> r.realized >= edges[i] && r.realized < edges[i+1]);
    if (idx === -1) idx = labels.length - 1;
    bins[idx] += 1;
  }

  const wins   = rows.filter(r => r.realized >  0);
  const losses = rows.filter(r => r.realized <  0);
  const grossProfit = wins.reduce((a,b)=>a+b.realized, 0);
  const grossLoss   = losses.reduce((a,b)=>a+b.realized, 0);
  const net         = grossProfit + grossLoss;
  const winRate     = rows.length ? (wins.length/rows.length)*100 : 0;
  const avgWin      = wins.length   ? grossProfit / wins.length      : 0;
  const avgLossAbs  = losses.length ? Math.abs(grossLoss / losses.length) : 0;
  const profitFactor = Math.abs(grossLoss) > 1e-12 ? (grossProfit/Math.abs(grossLoss)) : (grossProfit>0 ? 9999 : 0);

  res.json({
    ok: true,
    dry: DRY_RUN,
    dailyKey: stats.dailyKey,
    counts: { trades: rows.length, wins: wins.length, losses: losses.length },
    pnl: {
      grossProfit: Number(grossProfit.toFixed(8)),
      grossLoss:   Number(grossLoss.toFixed(8)),
      net:         Number(net.toFixed(8))
    },
    quality: {
      winRate: Number(winRate.toFixed(2)),
      avgWin:  Number(avgWin.toFixed(8)),
      avgLoss: Number(avgLossAbs.toFixed(8)),
      profitFactor: Number(profitFactor.toFixed(3))
    },
    risk: { maxDrawdown: Number(maxDD.toFixed(8)) },
    streaks: { currentWins: 0, currentLosses: 0, maxWins: 0, maxLosses: 0 }, // needs real fills to compute
    equity, drawdown,
    hist: { labels, bins },
    lastEvents: logs.slice(-25).map(l=>`[${new Date(l.ts).toISOString()}] ${l.msg}`)
  });
});

// Daily aggregate
app.get("/stats/daily", (req, res) => {
  ensureDaily();
  // One current day row from realized fills
  const rows = fills.map(f => ({ ts: f.ts, realized: Number(f.realized||0) }));
  const wins   = rows.filter(r => r.realized > 0).length;
  const losses = rows.filter(r => r.realized < 0).length;
  const grossP = rows.filter(r => r.realized > 0).reduce((a,b)=>a+b.realized, 0);
  const grossL = rows.filter(r => r.realized < 0).reduce((a,b)=>a+b.realized, 0);
  const net    = grossP + grossL;
  const trades = rows.length;
  const pf = Math.abs(grossL) > 1e-12 ? (grossP/Math.abs(grossL)) : (grossP>0 ? 9999 : 0);
  const wr = trades ? (wins/trades)*100 : 0;

  res.json({ ok:true, daily: [{
    key: stats.dailyKey,
    startIso: fills[0] ? new Date(fills[0].ts).toISOString() : null,
    endIso:   fills[rows.length-1] ? new Date(fills[rows.length-1].ts).toISOString() : null,
    trades, wins, losses,
    winRate: Number(wr.toFixed(2)),
    profitFactor: Number(pf.toFixed(3)),
    grossProfit: Number(grossP.toFixed(8)),
    grossLoss:   Number(grossL.toFixed(8)),
    net:         Number(net.toFixed(8))
  }]});
});

// Trade history & logs (JSON)
app.get("/fills", (req,res)=> res.json(fills));
app.get("/logs",  (req,res)=> res.json(logs));

// CSV exports
app.get("/pnl.csv", (req,res)=>{
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.write("ts_iso,symbol,side,price,amount,fee_usdt,realized_usdt\n");
  for (const f of fills) {
    res.write(`${new Date(f.ts).toISOString()},${f.symbol||""},${f.side||""},${Number(f.price||0)},${Number(f.amount||0)},${Number(f.fee||0)},${Number(f.realized||0)}\n`);
  }
  res.end();
});
app.get("/logs.csv", (req,res)=>{
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.write("ts_iso,event\n");
  for (const l of logs) res.write(`${new Date(l.ts).toISOString()},${(l.msg||"").replace(/,/g,";")}\n`);
  res.end();
});

// Live SSE stream for dashboard
app.get("/stream", (req,res)=>{
  res.writeHead(200, {
    "Content-Type":"text/event-stream",
    "Cache-Control":"no-cache",
    "Connection":"keep-alive"
  });
  const send = (type, payload)=> res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  send("hello", { ok:true, ts: Date.now() });
  const onLog = (d)=> send("log", d);
  events.on("log", onLog);
  req.on("close", ()=> events.off("log", onLog));
});

// TradingView webhook (POST only)
app.post("/webhook", (req, res) => {
  try {
    ensureDaily();

    // Accept secret in header or body
    const headerSecret = req.get("X-Webhook-Secret");
    const bodySecret   = req.body?.secret;
    if (WEBHOOK_SECRET && headerSecret !== WEBHOOK_SECRET && bodySecret !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok:false, error:"unauthorized" });
    }

    // Your alert JSON should include at least: { signal, symbol, leverage, notional, relayTimer, autoCloseSec }
    const b = req.body || {};
    const signal = String(b.signal || "").toUpperCase();
    if (!["LONG","SHORT","CLOSE_LONG","CLOSE_SHORT"].includes(signal)) {
      return res.status(400).json({ ok:false, error:"bad_signal" });
    }

    const symbol = String(b.symbol || "").toUpperCase();
    const ts = Date.now();

    // We do NOT fabricate fills here. We only log the signal.
    stats.tradesToday += 1;
    stats.tradesLastHour += 1;
    stats.signals.unshift({ signal, symbol, time: new Date(ts).toISOString() });
    if (stats.signals.length > 50) stats.signals.pop();

    logMsg(`EXEC ${signal} ${symbol}`);
    events.emit("exec", { ts, symbol, signal });

    return res.json({ ok:true, dry: DRY_RUN, symbol, signal });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
});

// Root — tiny helper page
app.get("/", (req,res)=>{
  res.type("html").send(`<pre>
MEXC Relay (no-sim, no-fake)
Endpoints:
GET  /health
GET  /stats
GET  /stats/daily
GET  /fills
GET  /logs
GET  /pnl.csv
GET  /logs.csv
GET  /stream        (SSE)
POST /webhook       (JSON from TradingView)
</pre>`);
});

app.listen(PORT, ()=> {
  console.log(`[relay] listening on :${PORT}, DRY_RUN=${DRY_RUN}`);
});
