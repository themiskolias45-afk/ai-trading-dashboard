Pull the full performance report from SmartEntry Pro. Do this:

1. Fetch http://localhost:3001/api/journal
2. Fetch http://localhost:3001/api/stats/by-setup

Report:

PERFORMANCE SUMMARY
---
Total trades: X | Wins: X | Losses: X | Win rate: X%
Total P&L: $X | Best trade: $X | Worst trade: $X

BY SETUP:
• [SETUP_NAME]: X trades | X% WR | avg P&L $X — [EDGE / OK / REVIEW]

CONFIDENCE CALIBRATION:
• 65-74%: X% actual WR (should be ~65%)
• 75-84%: X% actual WR
• 85%+:   X% actual WR

VERDICT:
• Best setup: [name it]
• Weakest setup: [name it — consider disabling if WR < 40%]
• Confidence model: [calibrated / overconfident / underconfident]

Ask if I want to tune any setup parameters.
