Analyze SmartEntry Pro and find the single best improvement to make right now. Do this:

1. Fetch http://localhost:3001/api/backtest
2. Fetch http://localhost:3001/api/stats/by-setup
3. Fetch http://localhost:3001/api/journal

Identify the weakest point in the system — could be:
- A setup with poor win rate (< 45%)
- Confidence scores not matching actual win rates
- An asset that consistently underperforms
- A parameter that's clearly wrong (stop too tight, target too far, etc.)

Report:

IMPROVEMENT ANALYSIS
---
WEAKEST POINT: [one clear problem]
ROOT CAUSE: [why is it happening — be specific]
PROPOSED FIX: [exact code change or parameter tweak]
EXPECTED IMPACT: [estimated WR improvement or cost reduction]

RISK: [what could go wrong with this fix]

Ask: "Implement this fix? (Y/N)"
If yes — implement it, run backtest to verify, commit the change.
