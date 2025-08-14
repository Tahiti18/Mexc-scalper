# MEXC Relay — Advanced

Deploy on Railway. Endpoints:
- POST /webhook (TV alert; secret/HMAC)
- GET  /health
- GET  /pnl.csv
- GET  /logs.csv
- GET  /config
- POST /admin/halt       { "symbol": "BTC/USDT:USDT" }
- POST /admin/unhalt     { "symbol": "BTC/USDT:USDT" }
- POST /admin/cooldown   { "symbol": "BTC/USDT:USDT", "seconds": 60 }
- GET  /                 tiny HTML dashboard (requires ?token= if DASHBOARD_TOKEN set)
