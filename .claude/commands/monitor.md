Continuous signal monitor — watches all assets and alerts when a trade setup is ready.

Usage: /monitor [--interval 5] [--asset BTC|GOLD|SPX|ALL]

$ARGUMENTS may contain --interval N (minutes, default 5) and --asset filter.

═══ MONITOR LOOP ═══

Every N minutes, automatically:

1. FETCH SIGNALS
   GET http://localhost:3001/api/signals
   GET http://localhost:3001/api/prices

2. CHECK FOR ALERTS
   For each asset (BTC, Gold, SPX):
   - confidence ≥ 65% AND signal is BUY or SELL → FIRE ALERT
   - confidence changed by ≥ 15% since last check → note the move
   - price moved > 1.5% since last check → note volatility spike

3. ON ALERT — report immediately:
   ⚡ SIGNAL: [ASSET] [BUY/SELL] [confidence]%
   Entry: $[price] | Stop: $[stop] | Target: $[target] | R:R: [ratio]
   Setup: [setup name] | Regime: [regime]
   Action: approve in Auto Trade tab or type /trade [ASSET] to execute

4. ON NO SIGNAL:
   Show a one-line status: "[time] — BTC [conf]% | Gold [conf]% | SPX [conf]% — no setup ready"

5. LOOP
   Wait N minutes. Repeat from step 1.
   Stop when user types /stop or presses Ctrl+C.

═══ RULES ═══
- Never fire the same alert twice in a row for the same asset at the same confidence
- If server is offline, report it once and keep trying — don't stop the loop
- Keep output compact — one line per check unless an alert fires
- If confidence drops below 65% after firing, note: "[ASSET] signal faded — [new conf]%"
