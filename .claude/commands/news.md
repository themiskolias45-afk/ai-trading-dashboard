Fetch live market news and give me a trading-relevant briefing.

Steps:
1. WebFetch https://finance.yahoo.com/rss/topfinstories — scan headlines
2. WebFetch https://feeds.finance.yahoo.com/rss/2.0/headline?s=BTC-USD,GC=F,SPY&region=US&lang=en-US
3. WebFetch http://localhost:3001/api/risk-status — get current regime

Synthesize into this format:

---
NEWS BRIEF — [time now]
---
MACRO RISK: [HIGH/MEDIUM/LOW] — [one sentence why]

BTC: [any relevant headlines — if none, say "clean"]
GOLD: [any relevant headlines]
SPX: [any relevant headlines]

TRADING IMPACT:
• [bullet: what this means for today's setups]
• [bullet: any news blackout needed before major release?]
• [bullet: one actionable takeaway]
---

Flag anything that should trigger a news blackout (FOMC, CPI, NFP within 2 hours).
