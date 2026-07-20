Weekly performance review and improvement plan.

Steps:
1. Fetch http://localhost:3001/api/journal — all trades
2. Fetch http://localhost:3001/api/learning — setup stats
3. Use sequential thinking to find: what's working, what's broken, what to change

Calculate:
- Total trades this week / month
- Win rate overall and per setup
- Best setup (highest win rate with 5+ trades)
- Worst setup (lowest win rate with 5+ trades)
- Average R:R achieved vs planned
- Biggest single win and loss
- Consecutive loss streaks

Output format:
---
PERFORMANCE REVIEW — [date range]
---
TRADES: X total | X wins | X losses | Win rate: X%
P&L: $X | Avg win: $X | Avg loss: $X | Expectancy: $X/trade

BEST SETUP: [name] — X% win rate over X trades (+$X total)
WORST SETUP: [name] — X% win rate over X trades (-$X total)

WHAT'S WORKING:
• [bullet]
• [bullet]

WHAT TO FIX:
• [bullet — specific, actionable]
• [bullet]

ACTION PLAN:
1. [concrete change to implement this week]
2. [concrete change]

PARAMETER CHANGES RECOMMENDED: [yes/no — if yes, state exact change]
---

Be brutally honest. No sugar-coating. If a setup is losing money, say kill it.
