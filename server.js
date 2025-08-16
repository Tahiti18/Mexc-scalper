import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

const app = express();
app.use(bodyParser.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "yoursecret";
const DRY_RUN = true; // force demo mode ON

// Stats memory
let stats = {
  dry: DRY_RUN,
  dailyKey: new Date().toISOString().split("T")[0],
  tradesToday: 0,
  pnlToday: 0,
  tradesLastHour: 0,
  signals: []
};

// Reset daily stats at midnight
function resetDaily() {
  const today = new Date().toISOString().split("T")[0];
  if (stats.dailyKey !== today) {
    stats.dailyKey = today;
    stats.tradesToday = 0;
    stats.pnlToday = 0;
    stats.tradesLastHour = 0;
    stats.signals = [];
  }
}

// Webhook endpoint
app.post("/webhook", (req, res) => {
  const { secret, signal } = req.body;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ ok: false, error: "Invalid secret" });
  }

  if (!signal || !["LONG", "SHORT"].includes(signal)) {
    return res.status(400).json({ ok: false, error: "Invalid signal" });
  }

  resetDaily();

  // Update stats
  stats.tradesToday++;
  stats.tradesLastHour++;
  stats.signals.unshift({ signal, time: new Date().toISOString() });

  // Keep only last 20 signals
  if (stats.signals.length > 20) stats.signals.pop();

  res.json({ ok: true, dry: DRY_RUN, signal });
});

// Stats endpoint
app.get("/stats", (req, res) => {
  resetDaily();
  res.json(stats);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
