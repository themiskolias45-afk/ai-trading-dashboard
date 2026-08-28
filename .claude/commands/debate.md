Run a multi-agent signal debate for a specific asset. Usage: /debate [BTC|GOLD|SPX] [LONG|SHORT]

$ARGUMENTS: [SYMBOL] [DIRECTION] — e.g. "GOLD LONG" or "BTC SHORT"

Spawns the Python debate agents to argue for and against the proposed trade direction.
Returns a structured verdict with the strongest arguments on both sides and a final recommendation.

Requires the server to be running and a live signal to debate.

═══ STEP 1 — FETCH LIVE DATA ═══
  Call: mcp__smartentry__get_signals → get confidence, entry, stop, target for [SYMBOL]
  Call: mcp__smartentry__get_risk_status → regime, circuit breaker status
  If regime is HALTED: "Trading halted — debate is academic. Show anyway? (Y/N)"

═══ STEP 2 — RUN DEBATE ═══
  Extract from signals: confidence, entry, stop, target
  Run: python debate_agents.py [SYMBOL] [DIRECTION] [confidence] [entry] [stop] [target]
  Capture full output — both sides' arguments and the verdict.

═══ STEP 3 — REPORT ═══
DEBATE — [SYMBOL] [DIRECTION] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SETUP:   conf [X]% | entry [price] | stop [price] | target [price] | R:R 1:[X]
REGIME:  [current regime]

BULL CASE: [strongest argument for]
BEAR CASE: [strongest argument against]

VERDICT: [TAKE / SKIP / WAIT] — [one-sentence reason]
CONFIDENCE IN VERDICT: [HIGH / MEDIUM / LOW]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If TAKE: "Approve trade? /execute [SYMBOL] [DIRECTION] [entry] [stop] [target]"
If SKIP/WAIT: "Note the reason — log with /trade [details]?"
