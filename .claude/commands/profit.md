Autonomous profitability improvement loop. Runs up to 5 rounds — each round finds the weakest link and fixes it.

Usage: /profit [--rounds N]  (default 5 rounds)

This is the most powerful improvement command. It combines web research, code analysis, backtesting, and auto-implementation in a single loop.

═══ EACH ROUND ═══

STEP 1 — DIAGNOSE (parallel):
- Fetch http://localhost:3001/api/stats/by-setup — win rates per setup
- Fetch http://localhost:3001/api/journal (last 100 trades) — P&L breakdown
- Fetch http://localhost:3001/api/backtest — backtest metrics
- Fetch http://localhost:3001/api/sentiment — market conditions
- Run: python self_improve.py scan --save

STEP 2 — RESEARCH (parallel, target the weakest area found in Step 1):
- Brave search: "improve [WEAKEST_SETUP] trading strategy win rate [asset]"
- Brave search: "quantitative [ASSET] trading edge 2025 backtested"
- Exa search: "algorithmic trading [WEAKEST_SETUP] filter confidence calibration"
- Brave search: "professional trader [ASSET] signal quality improvement"

STEP 3 — IMPLEMENT:
Pick the single highest-impact fix from Steps 1+2.
Criteria:
  a) Will it increase win rate on the worst-performing setup by ≥5%?
  b) Is it supported by at least one external research finding?
  c) Can it be implemented without breaking existing trades?

Only implement if all three are YES.
If a fix is risky (touches live signal logic), show the diff and ask for approval first.
Low-risk fixes (thresholds, boosts, filters) implement immediately.

STEP 4 — VERIFY:
After implementing: fetch /api/backtest and compare metrics.
Report: what changed, expected vs actual improvement.

STEP 5 — PERSIST:
- Commit the change with a descriptive message
- Run: python memory.py add "profit-loop" "[what was changed and why]" "IMPROVEMENT"
- Note in today's daily notes

═══ BETWEEN ROUNDS ═══
Report a one-line round summary:
  Round X/N: Fixed [what] on [asset/setup] — estimated +X% WR | Next: [next weakest area]

Stop early if:
- No setup has WR < 50% (system is performing well)
- The last 2 rounds found no implementable fix
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
