Deep diagnostic — find exactly why no trades are opening. Usage: /diagnose

Use when the system is running but not taking any trades. Traces the full signal → execution pipeline.

═══ STEP 1 — GATHER ALL STATE (parallel) ═══
  mcp__smartentry__get_signals              → current signal for all 3 assets
  mcp__smartentry__get_risk_status          → halted? consecutiveLosses? regime? dailyPnL?
  mcp__smartentry__get_healer               → which of 6 health checks are failing?
  mcp__smartentry__get_journal limit=20     → when was the last trade?
  mcp__smartentry__get_learning             → setup win rates and confidence boosts

  Also fetch (HTTP):
  GET http://localhost:3001/api/setup-health   → which setups are disabled today?

═══ STEP 2 — CHECK EACH POSSIBLE CAUSE IN ORDER ═══

  CAUSE A — CIRCUIT BREAKER ACTIVE:
    Is risk_status.halted = true OR consecutiveLosses >= 3?
    → If YES: "TRADING HALTED — circuit breaker. Reset requires X consecutive wins or manual reset."
    → Check: is this intentional or a bug (e.g., losses from a system error, not real trades)?

  CAUSE B — CONFIDENCE NEVER REACHES THRESHOLD:
    From signals: what is the highest confidence seen across all 3 assets?
    If max confidence < 65%: market conditions are not generating setups.
    → Check: when was the last time confidence was ≥ 65%? (from journal timestamps)
    → Is it a ranging market killing all setups, or is the signal logic broken?

  CAUSE C — SIGNAL STUCK IN WAIT:
    Read server/index.js — find the generateSignal() function.
    Trace: what conditions produce direction !== 'WAIT'?
    → Is there a hardcoded flag, disabled state, or condition that's always false?
    → Is the healer reporting stale data (updatedAt > 60 min ago)?

  CAUSE D — SETUP HEALTH DISABLING ALL SETUPS:
    From /api/setup-health: are any setups listed as AVOID or DISABLED?
    If ALL setups are disabled → no signal can fire.
    → Why were they disabled? WR too low? Manual override?

  CAUSE E — MT5 BRIDGE NOT CONNECTED:
    Check tasks\logs\bridge_log.txt (last 50 lines).
    Look for: "Connected", "Disconnected", "Error", "timeout", "MT5 not running"
    → If disconnected: trade signals generate but never reach MT5 → no execution.
    → Is MT5 terminal open on the machine? Is the bridge process running?

  CAUSE F — DATA STALENESS BLOCKING SIGNALS:
    From get_healer: is "data freshness" check failing?
    If signals are > 60 min old: generateSignal() may be returning WAIT as a safety measure.
    → Force heal: POST /api/healer/heal → wait 10s → re-check signals.

  CAUSE G — SERVER CRASH LOOP:
    Check tasks\logs\server_log.txt (last 100 lines) for repeated restarts.
    Check tasks\logs\startup_log.txt for any crash patterns.
    If server is restarting every few minutes → it's not stable long enough to fire signals.

  CAUSE H — API KEY EXPIRED OR INVALID:
    If signal generation requires the Claude API (for AI analysis):
    Check tasks\logs\server_log.txt for: 401, 403, "API key", "authentication"
    If API key expired → AI signals return error → system falls back to WAIT.

═══ STEP 3 — TRACE THE EXACT BLOCKING POINT ═══
  Once the cause is identified, read the FULL relevant function in server/index.js.
  Trace the exact code path that prevents a trade from firing.
  Find: which specific condition evaluates to false/null/undefined?

═══ STEP 4 — FIX ═══
  Apply the CHANGING/NOW/AFTER/RISK scaffold before touching any code.
  If RISK = HIGH (signal logic, risk gate) → show the change and wait for approval.
  If RISK = LOW (config value, threshold) → fix immediately.

  After fix:
  - node --check server/index.js
  - Restart server if changed
  - Wait 60s for signal refresh
  - Verify: mcp__smartentry__get_signals → confidence ≥ 65 on at least one asset?

═══ REPORT ═══
TRADE DIAGNOSTIC — [timestamp]
Days since last trade: [X]
Last trade: [date, setup, asset, result]

ROOT CAUSE: [one sentence — exact cause identified]
LOCATION: [file:function:line if code issue]
FIX APPLIED: [what was changed, or NONE NEEDED if market conditions]
VERIFIED: [yes — signals now generating / no — still investigating]

NEXT TRADE READINESS:
  BTC:  confidence [X]% | [READY if ≥65 and not halted / WAITING]
  GOLD: confidence [X]% | [READY / WAITING]
  SPX:  confidence [X]% | [READY / WAITING]
