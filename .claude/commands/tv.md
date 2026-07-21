Full TradingView management. Usage: /tv [action]

Actions:
  /tv draw [symbol]          — draw daily plan levels on chart
  /tv alert [sym] [price]    — set a price alert on TradingView
  /tv pine [symbol]          — generate Pine Script only (no browser)
  /tv login                  — test TradingView login
  /tv plan                   — draw all 3 charts + generate Pine Scripts

If no action given, run full daily plan: draw all three symbols.

For /tv draw:
  1. Get signal levels from http://localhost:3001/api/signals
  2. Run: python tradingview_bot.py draw [sym] [entry] [stop] [target] [support] [resistance]
  3. Report what was drawn

For /tv alert [sym] [price]:
  Run: python tradingview_bot.py alert [sym] [price] "SmartEntry alert — JARVIS"

For /tv pine [sym]:
  Run: python tradingview_bot.py pine [sym] [entry] [stop] [target]
  Print the Pine Script and tell user to paste it into TradingView

For /tv login:
  Run: python tradingview_bot.py test
  Report success or failure

For /tv plan (full daily setup):
  1. Fetch all signals
  2. Draw BTC chart
  3. Draw GOLD chart
  4. Draw SPX chart
  5. Generate Pine Scripts for all three as backup
  6. Report full summary

If tasks\setup_tradingview.bat has not been run (no TV_USERNAME in keys.env):
  Tell user: "Run tasks\setup_tradingview.bat first to connect TradingView"
