Continuous signal monitor — watches all assets and alerts when a trade setup is ready.

Usage: /monitor [--interval 5] [--asset BTC|GOLD|SPX|ALL]

$ARGUMENTS may contain --interval N (minutes, default 5) and --asset filter.

═══ STEP 0 — BOOT CHECK (runs once before the loop starts) ═══

1. FETCH THE LIVE GATE (L1):
   GET http://localhost:3001/api/strategy-settings
   Read confidenceThreshold → store as LIVE_GATE.
   If settingsError is non-null: print "⚠ SETTINGS ERROR: server on defaults — gate may be wrong"
   Use LIVE_GATE for ALL alert comparisons. Never hardcode a number.
   Re-fetch strategy-settings every 30 minutes — the gate may change while the monitor runs.

2. FETCH FLEET STATE (L2):
   Call mcp__smartentry__get_fleet_status
   - FLEET DIVERGES: print once "⚠ FLEET SPLIT: gate this=[X] peer=[Y] — alerts calibrated to THIS BOX only, VPS may reject them"
     Prepend [SPLIT] to every subsequent status line while divergence persists.
   - PEER UNREACHABLE: print once "⚠ PEER UNREACHABLE — VPS gate unknown, alerts are laptop-only"
   - FLEET AGREES: continue silently.
   Re-check fleet status every 30 minutes.

═══ MAIN LOOP — every N minutes ═══

1. FETCH SIGNALS AND RISK (L3)
   GET http://localhost:3001/api/signals
   GET http://localhost:3001/api/prices
   GET http://localhost:3001/api/risk-status

2. CHECK HALTED STATE (L3)
   If risk.halted === true: skip alert check — go to step 5 (ON NO SIGNAL, path a).
   If risk.halted changed from true → false since last check: print "✅ HALT CLEARED — monitoring resumed"

3. CHECK FOR ALERTS (only when not halted)
   For each asset (BTC, Gold, SPX):
   - confidence ≥ LIVE_GATE AND signal is BUY or SELL → FIRE ALERT
   - confidence changed by ≥ 15% since last check → note the move
   - price moved > 1.5% since last check → note volatility spike

4. ON ALERT — report immediately:
   ⚡ SIGNAL: [ASSET] [BUY/SELL] [confidence]%
   Entry: $[price] | Stop: $[stop] | Target: $[target] | R:R: [ratio]
   Setup: [setup name] | Regime: [regime]
   Action: approve in Auto Trade tab or type /trade [ASSET] to execute

5. ON NO SIGNAL — use the correct status line:
   a. HALTED:  "⚠ HALTED ([consecutiveLosses] consecutive losses — [haltReason]): BTC [conf]% | Gold [conf]% | SPX [conf]% — no signal will fire until halt clears"
   b. SPLIT:   "[SPLIT] [time] — BTC [conf]% | Gold [conf]% | SPX [conf]% — no setup ready (gate may differ on VPS)"
   c. NORMAL:  "[time] — BTC [conf]% | Gold [conf]% | SPX [conf]% — no setup ready"

6. LOOP
   Wait N minutes. Repeat from step 1.
   Stop when user types /stop or presses Ctrl+C.

═══ RULES ═══
- Never fire the same alert twice in a row for the same asset at the same confidence
- If server is offline, report it once and keep trying — don't stop the loop
- Keep output compact — one line per check unless an alert fires
- If confidence drops below LIVE_GATE after firing, note: "[ASSET] signal faded — [new conf]%"
- To loop /tv screenshots instead: use `/loop 15m /tv watch` rather than adding a scheduled task
