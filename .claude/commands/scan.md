Parallel market scan — all assets scored and ranked. Usage: /scan [BTC|GOLD|SPX|all] [--debate]

$ARGUMENTS may contain asset symbols or --debate flag.

═══ PRIMARY — Direct API (always works) ═══
Fetch in parallel:
  GET http://localhost:3001/api/signals      → all three assets
  GET http://localhost:3001/api/sentiment    → Fear & Greed context
  GET http://localhost:3001/api/risk-status  → regime + circuit breaker

Score each asset (0–100):
  +30 if confidence ≥ 75%
  +20 if confidence 65–74%
  +15 if sentiment aligns with signal direction (Fear < 40 + BUY, or Greed > 60 + SELL)
  +15 if market regime = TRENDING
  +10 if circuit breaker is clear
  -20 if news blackout active
  -15 if circuit breaker is open

═══ ENHANCEMENT — Python scanner (run if available) ═══
Try: python market_scanner.py $ARGUMENTS
If it fails or errors, skip silently — the direct API results above are sufficient.

═══ REPORT FORMAT ═══

MARKET SCAN — [timestamp]
══════════════════════════
[For each asset, sorted by score descending:]
  [ASSET] [SIGNAL] [conf]% | Score: [0-100] | Setup: [name] | Sentiment: [ALIGNED/AGAINST/NEUTRAL]
  Entry $X | Stop $X | Target $X | R:R 1:X

Fear & Greed: [score] ([classification]) | Regime: [regime] | Circuit breaker: [CLEAR/OPEN]

TOP PICK: [highest-scored asset] — [2-sentence rationale]

If no signal ≥ 65%: "No setups ready — all assets below threshold. Regime: [regime]."

═══ DEBATE MODE (--debate) ═══
If --debate flag is passed AND top pick has confidence ≥ 70%:
  Run: python debate_agents.py [SYMBOL] [DIRECTION] [CONFIDENCE] [ENTRY] [STOP] [TARGET]
  Show debate verdict: TAKE / SKIP + reason

After scan: "Run debate on [top pick]? (Y/N)"
