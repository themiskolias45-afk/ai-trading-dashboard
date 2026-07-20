Check open trades and manage positions. Do this:

1. Fetch http://localhost:3001/api/mt5/positions
2. Fetch http://localhost:3001/api/journal?limit=5
3. Fetch http://localhost:3001/api/signals

Report:

OPEN POSITIONS:
• [symbol] [direction] | Entry $X | Current P&L: $X | Stop $X | Target $X
  Status: [on track / at risk / near target]

If no open positions: "No open positions."

LAST 5 CLOSED TRADES:
• [date] [symbol] [direction] — [WIN/LOSS] $X

RECOMMENDATION:
• [any position that should be closed or stop moved — be specific with levels]
• [next setup to watch]

Be direct. If a trade is losing badly, say so and suggest action.
