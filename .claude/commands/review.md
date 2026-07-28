Weekly performance review and improvement plan.

Usage: /review

STEP 1 — Load all data in parallel (MCP tools directly):
  mcp__smartentry__get_journal limit=200      → all recent trades
  mcp__smartentry__get_performance            → aggregate stats: WR, P&L, best/worst setup
  mcp__smartentry__get_learning               → setup calibration, win rates, boosts
  mcp__smartentry__get_risk_status            → regime, consecutive losses, circuit breaker history

STEP 2 — Calculate (from the data, not from memory):
  - Total trades this week / month
  - Win rate overall and per setup
  - Best setup: highest WR with ≥ 5 trades
  - Worst setup: lowest WR with ≥ 5 trades
  - Average R:R achieved vs planned (from journal entries)
  - Biggest single win and loss ($)
  - Longest losing streak
  - Confidence calibration:
      65-74%: actual WR (target ~65%)
      75-84%: actual WR (target ~75%)
      85%+:   actual WR (target ~85%)
      Flag any tier that's off by > 15%

STEP 3 — Be brutally honest. No sugar-coating.

Output:
---
PERFORMANCE REVIEW — [date range]
---
TRADES: X total | X wins | X losses | Win rate: X%
P&L: $X total | Avg win: $X | Avg loss: $X | Expectancy: $X/trade
Best trade: $X | Worst trade: $X | Longest losing streak: X

BY SETUP:
• [name]: X% WR / X trades / $X P&L — [STRONG / OK / REVIEW / KILL]

CONFIDENCE CALIBRATION:
• 65-74%: X% actual WR — [GOOD / OVERCONFIDENT / UNDERCONFIDENT]
• 75-84%: X% actual WR — [GOOD / OVERCONFIDENT / UNDERCONFIDENT]
• 85%+:   X% actual WR — [GOOD / OVERCONFIDENT / UNDERCONFIDENT]

WHAT'S WORKING:
• [specific — name the setup, timeframe, asset]

WHAT TO FIX:
• [specific — name the exact parameter or logic to change]

ACTION PLAN:
1. [concrete — exactly what to change in server/index.js or learning config]
2. [concrete]

VERDICT:
• Keep & scale: [setup name]
• Kill or pause: [setup name — reason]
• Calibration: [calibrated / needs tuning — which direction]
---

After the review, ask: "Implement any of these changes now? (Y/N)"
If yes → run /improve or /fix targeting the specific setup.
