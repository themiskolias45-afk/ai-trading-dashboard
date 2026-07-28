Full performance report. Usage: /journal

Use SmartEntry MCP tools directly.

Call in parallel:
  mcp__smartentry__get_journal limit=50      → trade history
  mcp__smartentry__get_performance           → aggregate stats: WR, P&L, best/worst setup
  mcp__smartentry__get_learning              → setup calibration + boosts

HTTP fallback:
  GET http://localhost:3001/api/journal
  GET http://localhost:3001/api/stats/by-setup

Report:

PERFORMANCE SUMMARY
---
Total trades: X | Wins: X | Losses: X | Win rate: X%
Total P&L: $X | Best trade: $X | Worst trade: $X | Expectancy: $X/trade

BY SETUP:
• [SETUP_NAME]: X trades | X% WR | avg P&L $X — [EDGE / OK / REVIEW / KILL]

CONFIDENCE CALIBRATION:
• 65-74%: X% actual WR (target ~65%)
• 75-84%: X% actual WR (target ~75%)
• 85%+:   X% actual WR (target ~85%)
[Flag if any tier is overconfident by >15%]

VERDICT:
• Best setup:   [name — keep and scale]
• Weakest setup: [name — consider disabling if WR < 40%]
• Calibration:  [calibrated / overconfident / underconfident]

Ask: "Tune any setup parameters? (Y/N)"
