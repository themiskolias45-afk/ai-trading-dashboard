Find and implement the single best improvement to SmartEntry Pro right now.
Uses web research + code analysis + performance data for maximum-quality recommendations.

Step 1 — Parallel data gathering (all at once):
- Run: python self_improve.py scan --save
- Fetch http://localhost:3001/api/backtest
- Fetch http://localhost:3001/api/stats/by-setup
- Fetch http://localhost:3001/api/journal (last 50 trades)
- Fetch http://localhost:3001/api/sentiment

Step 2 — Web research for external intelligence (all at once):
- Brave search: "best algorithmic trading signal improvements 2025 BTC gold SPX"
- Brave search: "quantitative trading confidence score calibration techniques"
- Exa search: "profitable crypto trading strategies RSI MACD backtested 2024 2025"

Step 3 — Synthesize all sources:
Cross-reference: code issues + performance data + external research.
Which problem costs the most money or introduces the most risk?
What does current research say the best approach is?

Weaknesses to look for:
- Setup with win rate < 45% (cut it or tune it based on research)
- Confidence scores not matching actual win rates (calibration drift)
- High-severity code issue from scan (empty catch, injection risk, silent failure)
- API route that returns 500 (check_errors.py will catch this)
- An asset consistently underperforming others
- Fear & Greed extreme readings not being used (if sentiment data is stale or missing)
- Missing filters that research shows improve R:R (volume, spread, correlation)

Report:

IMPROVEMENT ANALYSIS — [date]
---
CODE SCAN: X issues found (X HIGH, X MEDIUM)
TRADING WEAKNESS: [worst-performing metric from live data]
RESEARCH INSIGHT: [best relevant finding from web research]

BEST IMPROVEMENT TO MAKE NOW:
  WHAT: [one clear problem statement]
  WHY: [root cause — specific, not generic]
  EVIDENCE: [data point or research finding that confirms this]
  FIX: [exact code change, parameter value, or route to add/remove]
  IMPACT: [estimated WR improvement, risk reduction, or stability gain]
  RISK: [what could break if this fix is wrong]

Ask: "Implement this fix? (Y/N)"
If yes — implement it, run backtest to verify, commit the change.
If the fix touches server/index.js, always read the full function before editing.
