Autonomous profitability improvement loop. Finds the weakest link and fixes it, up to N rounds.

Usage: /profit [--rounds N]  (default 5 rounds)

═══ EACH ROUND ═══

STEP 1 — DIAGNOSE (parallel, MCP tools directly):
  mcp__smartentry__get_performance          → WR, P&L, worst setup
  mcp__smartentry__get_learning             → setup calibration, win rates, boosts
  mcp__smartentry__get_journal limit=100    → last 100 trades, P&L breakdown
  mcp__smartentry__get_risk_status          → regime, circuit breaker, consecutive losses
  mcp__smartentry__get_signals              → current signal quality and confidence

STEP 2 — RESEARCH (parallel, target the weakest area from Step 1):
  Brave search: "improve [WEAKEST_SETUP] trading strategy win rate [asset]"
  Brave search: "quantitative [ASSET] trading edge 2025 backtested"

STEP 3 — IMPLEMENT:
  Pick the single highest-impact fix.
  Criteria (all three must be YES):
    a) Will it increase win rate on worst setup by ≥ 5%?
    b) Supported by at least one external finding?
    c) Can implement without breaking live trades?

  If risky (touches live signal logic) → show diff, ask for approval
  If low-risk (thresholds, boosts, filters) → implement immediately

  Before any code edit: read the FULL function, not just the line.
  After edit: node --check server/index.js — fix before continuing.

STEP 4 — VERIFY:
  mcp__smartentry__get_performance          → compare metrics post-fix
  mcp__smartentry__get_learning             → confirm calibration improved
  Report: what changed, expected vs actual.

STEP 5 — PERSIST:
  git add server/index.js && git commit -m "[what changed and why]"
  mcp__smartentry__write_memory key="profit-loop-[date]" value="[fix summary]"
  mcp__smartentry__log_note tag="IMPROVEMENT" text="[round X: fixed [what] on [setup/asset]]"

═══ BETWEEN ROUNDS ═══
One-line summary:
  Round X/N: Fixed [what] on [asset/setup] — estimated +X% WR | Next: [weakest remaining]

Stop early if:
- No setup has WR < 50% (system performing well)
- Last 2 rounds found no implementable fix
- User types /stop

═══ FINAL REPORT ═══
PROFIT LOOP COMPLETE — [N] rounds
---
Changes made:
1. [fix 1] — [estimated impact]
2. [fix 2] — [estimated impact]

Overall expected improvement: [+X% win rate / +X% avg R:R / -X% drawdown]
Next area to improve: [one sentence]
---
