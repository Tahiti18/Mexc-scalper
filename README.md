# MEXC Scalper Relay — Advanced

**Features**
- Webhook receiver with secret/HMAC
- Guards (spread, rate limit, cooldown after loss, loss-streak halt)
- Auto-close timer
- SSE live stream
- CSV exports (`/pnl.csv`, `/logs.csv`)
- Stats API (`/stats`, `/stats/daily`)
- Admin controls: halt/unhalt/cooldown, master halt/unhalt-all, reset
- Simulators: simfill, simseq, simstrategy, simstrategy2 (inventory-aware legs)
- CORS gated to your Netlify origin

**Deploy (Railway)**
1) Push the backend folder to GitHub.  
2) New Railway Service → Deploy from repo.  
3) Set env vars (see `.env.example`).  
4) Deploy.  
5) Test `/health` and `/stats`.

**Webhook**
- Send TradingView alerts to: `https://YOUR_APP.up.railway.app/webhook`
- Header: `X-Webhook-Secret: WEBHOOK_SECRET`
- Body JSON: `{ "signal":"LONG", "symbol":"BTC/USDT:USDT", "notional":20, "leverage":100, "relayTimer":true, "autoCloseSec":20 }`

**Admin (token `DASHBOARD_TOKEN`)**
- POST `/admin/halt`, `/admin/unhalt`, `/admin/cooldown`
- POST `/admin/halt_all`, `/admin/unhalt_all`
- POST `/admin/reset`
- POST simulators: `/admin/simfill`, `/admin/simseq`, `/admin/simstrategy`, `/admin/simstrategy2`
