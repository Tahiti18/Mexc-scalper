import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import { EventEmitter } from "events";

const app = express();
app.use(bodyParser.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "yoursecret";
const DRY_RUN = true; // stays true until you toggle it

// In-memory data (use SQLite if you want persistence)
let stats = {
  dry: DRY_RUN,
  dailyKey: new Date().toISOString().split("T")[0],
  tradesToday: 0,
  pnlToday: 0,
  tradesLastHour: 0,
  wins: 0,
  losses: 0,
  signals: []
};

let fills = [];
let logs = [];
const events = new EventEmitter();

// Reset daily stats
function resetDaily() {
  const today = new Date().toISOString().split("T")[0];
  if (stats.dailyKey !== today) {
    stats.dailyKey = today;
    stats.tradesToday = 0;
    stats.pnlToday = 0;
    stats.tradesLastHour = 0;
    stats.wins = 0;
    stats.losses = 0;
    stats.signals = [];
    fills = [];
    logs.push({ msg: "Daily reset", time: new Date().toISOString() });
  }
}

// Helper: record trade
function recordTrade(signal) {
  const pnl = Math.random() * 10 - 5; // demo PnL
  const win = pnl >= 0;

  stats.tradesToday++;
  stats.tradesLastHour++;
  stats.pnlToday += pnl;
  win ? stats.wins++ : stats.losses++;
  stats.signals.unshift({ signal, time: new Date().toISOString() });

  const trade = {
    id: fills.length + 1,
    signal,
    time: new Date().toISOString(),
    size: 20,
    leverage: 100,
    pnl
  };
  fills.unshift(trade);

  logs.push({ msg: `Trade executed: ${signal} pnl=${pnl.toFixed(2)}`, time: trade.time });
  if (logs.length > 100) logs.shift();

  // stream to dashboard
  events.emit("signal", trade);
}

// Webhook for TradingView alerts
app.post("/webhook", (req, res) => {
  const { secret, signal } = req.body;
  if (secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ ok: false, error: "Invalid secret" });
  }
  if (!signal || !["LONG", "SHORT"].includes(signal)) {
    return res.status(400).json({ ok: false, error: "Invalid signal" });
  }

  resetDaily();
  recordTrade(signal);

  res.json({ ok: true, dry: DRY_RUN, signal });
});

// Stats endpoint
app.get("/stats", (req, res) => {
  resetDaily();
  res.json(stats);
});

// Daily stats
app.get("/stats/daily", (req, res) => {
  resetDaily();
  res.json({
    trades: stats.tradesToday,
    pnl: stats.pnlToday,
    wins: stats.wins,
    losses: stats.losses,
    winrate: stats.tradesToday > 0 ? (stats.wins / stats.tradesToday) * 100 : 0
  });
});

// Trade history
app.get("/fills", (req, res) => res.json(fills));

// Logs
app.get("/logs", (req, res) => res.json(logs));

// CSV exports
app.get("/pnl.csv", (req, res) => {
  const rows = fills.map(f => `${f.time},${f.signal},${f.pnl.toFixed(2)}`);
  res.setHeader("Content-Type", "text/csv");
  res.send("time,signal,pnl\n" + rows.join("\n"));
});

app.get("/logs.csv", (req, res) => {
  const rows = logs.map(l => `${l.time},${l.msg}`);
  res.setHeader("Content-Type", "text/csv");
  res.send("time,msg\n" + rows.join("\n"));
});

// Live stream (Server-Sent Events)
app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const listener = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  events.on("signal", listener);
  req.on("close", () => events.off("signal", listener));
});

// Admin routes
app.post("/admin/reset", (req, res) => {
  resetDaily();
  res.json({ ok: true, msg: "Daily stats reset" });
});

app.post("/admin/toggleDry", (req, res) => {
  stats.dry = !stats.dry;
  res.json({ ok: true, dry: stats.dry });
});

app.post("/admin/signal", (req, res) => {
  const { signal } = req.body;
  if (!signal || !["LONG", "SHORT"].includes(signal)) {
    return res.status(400).json({ ok: false, error: "Invalid signal" });
  }
  recordTrade(signal);
  res.json({ ok: true, injected: signal });
});

app.listen(PORT, () => {
  console.log(`🚀 Advanced server running on port ${PORT}`);
});
