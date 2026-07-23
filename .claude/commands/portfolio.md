Full portfolio risk analysis. Shows open positions, total exposure, drawdown scenario, and correlation risk.

Do this in order:

1. Fetch http://localhost:3001/api/mt5/positions
2. Fetch http://localhost:3001/api/risk-status
3. Fetch http://localhost:3001/api/signals
4. POST http://localhost:3001/api/size with each open position to get sizing validation

Calculate:
- Total capital at risk across ALL open positions (sum of (entry - stop) × lots for each)
- Portfolio risk % = total risk / account balance × 100
- Correlation risk: are any two positions in the same direction on correlated assets? (BTC/ETH = correlated, GOLD/USD = inversely correlated)
- Worst-case scenario: if all stops hit simultaneously, total loss in $

Report format:
---
PORTFOLIO RISK REPORT — [timestamp]
---
OPEN POSITIONS: X

[For each position:]
  [SYMBOL] [LONG/SHORT] | Entry: $X | Current: $X | Stop: $X | Risk: $X ([X]% account)
  Status: [SAFE / NEAR STOP / AT TARGET]

TOTAL EXPOSURE:
  Capital at risk: $X ([X]% of account)
  Worst-case loss: $X (all stops hit)
  Status: [SAFE / WARNING / CRITICAL — critical if >3% total exposure]

CORRELATION ALERT:
  [any pairs of positions that move together — flag the combined risk]

RECOMMENDATIONS:
  [bullet: any position to close, move stop, or reduce size — be specific]
  [bullet: max one more trade allowed before hitting 3% limit]

VERDICT: [SAFE TO ADD POSITION / AT LIMIT — NO NEW TRADES / REDUCE EXPOSURE]
---

If no open positions: report "No open positions. Available risk budget: 3 trades at 1% each."
Be direct — if exposure is dangerous, say so clearly.
