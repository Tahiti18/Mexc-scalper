
# MEXC Scalper — Advanced (NO SIM)

Production relay for TradingView → MEXC (perp swaps). **No simulator**.  
**Endpoints**:
- `GET /` (dashboard)
- `GET /public/*` assets
- `GET /health` status & guards
- `GET /config` current config view
- `GET /stats` aggregate stats for charts
- `GET /stats/daily` day grouping
- `GET /pnl.csv` fills CSV
- `GET /logs.csv` logs CSV
- `GET /fills` fills JSON
- `GET /logs` logs JSON (last 500)
- `GET /stream` SSE live events
- `POST /webhook` TradingView alerts
- Admin (need `DASHBOARD_TOKEN` header or `?token=`):
  - `POST /admin/halt` {symbol}
  - `POST /admin/unhalt` {symbol}
  - `POST /admin/cooldown` {symbol,seconds}
  - `POST /admin/halt_all`
  - `POST /admin/unhalt_all`
  - `POST /admin/reset`

## Env Vars

```
DRY_RUN=true
WEBHOOK_SECRET=replace_me
DASHBOARD_TOKEN=replace_me
DEFAULT_SYMBOL=SOL/USDT:USDT
DEFAULT_NOTIONAL_USDT=20
DEFAULT_LEVERAGE=100
DEFAULT_ISOLATED=true
MAX_TRADES_PER_HOUR=60
MAX_SPREAD_PCT=0.03
REJECT_IF_THIN_BOOK=true
COOLDOWN_AFTER_LOSS_SEC=120
MAX_CONSEC_LOSSES=3
LOSS_HALT_COOLDOWN_MIN=10
LOSS_REDUCE_FACTORS=[1.0,0.7,0.4]
LOSS_MIN_NOTIONAL=5
DAILY_PNL_CAP_USDT=0
DAILY_RESET_HOUR_UTC=0
NETLIFY_ORIGIN=*
HMAC_ENABLED=false
HMAC_SECRET=
HMAC_HEADER=X-Signature
# Live mode only:
MEXC_KEY=
MEXC_SECRET=
```

## TradingView Alert

Webhook URL:
```
https://YOUR-RAILWAY-APP.up.railway.app/webhook?secret=WEBHOOK_SECRET
```

Message JSON:
```json
{
  "signal": "LONG",
  "symbol": "SOL/USDT:USDT",
  "notional": 20,
  "leverage": 100,
  "relayTimer": true,
  "autoCloseSec": 20
}
```
