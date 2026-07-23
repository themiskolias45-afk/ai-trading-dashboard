Find and implement the single best improvement to SmartEntry Pro right now.

Step 1 — Run the automated scan to find real code issues:
```
python self_improve.py scan --save
```

Step 2 — Get trading performance data:
- Fetch http://localhost:3001/api/backtest
- Fetch http://localhost:3001/api/stats/by-setup
- Fetch http://localhost:3001/api/journal (last 50 trades)

Step 3 — Synthesize: cross-reference code issues with performance data.
Which problem costs the most money or introduces the most risk?

Weaknesses to look for:
- Setup with win rate < 45% (cut it or tune it)
- Confidence scores not matching actual win rates (calibration drift)
- High-severity code issue from scan (empty catch, injection risk, silent failure)
- API route that returns 500 (check_errors.py will catch this)
- An asset that consistently underperforms vs others

Report:

IMPROVEMENT ANALYSIS — [date]
---
CODE SCAN: X issues found (X HIGH, X MEDIUM)
TRADING WEAKNESS: [the worst-performing metric from live data]

BEST IMPROVEMENT TO MAKE NOW:
  WHAT: [one clear problem statement]
  WHY: [root cause — be specific, not generic]
  FIX: [exact code change, parameter value, or route to remove]
  IMPACT: [estimated WR improvement, risk reduction, or stability gain]
  RISK: [what could break if this fix is wrong]

Ask: "Implement this fix? (Y/N)"
If yes — implement it, run backtest to verify, commit the change.
If the fix touches server/index.js, always read the full function before editing.
