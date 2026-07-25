Deep single-symbol analysis with live sentiment + news. Usage: /analyze BTC  or  /analyze GOLD  or  /analyze SPX

$ARGUMENTS is the symbol. If blank, analyze all three.

Do this in order — all steps required:

1. Fetch http://localhost:3001/api/signals — get current signal + confidence + reasoning
2. Fetch http://localhost:3001/api/sentiment — get Fear & Greed index + classification
3. Fetch http://localhost:3001/api/learning — historical win rate for this setup
4. Fetch http://localhost:3001/api/journal — last 20 trades, filter for this symbol
5. Web search (Brave MCP): "[SYMBOL] price analysis today [date]" — get live market context
6. Web search (Brave MCP): "[SYMBOL] news today" — any major catalysts or risks
7. Use mcp__sequential-thinking to reason through all data

Sequential thinking questions:
- What is the technical signal saying and why? (RSI/MACD/BB/EMA alignment)
- What does Fear & Greed = X (classification) mean for this trade? Is it extreme?
- Are there news catalysts that support or invalidate the setup?
- What is the win rate on this setup historically? Has it been improving or degrading?
- What did the last 5 trades on this symbol look like? Any streak?
- Is the current market regime favorable? (VIX, DXY, cross-asset)
- What is the exact entry, stop, target and R:R?
- What single event would immediately invalidate this setup?
- Final verdict: TAKE IT / WAIT / SKIP — with conviction score

Output format:
---
DEEP ANALYSIS — [SYMBOL] — [timestamp]
---
Signal: [LONG/SHORT/WAIT] | Setup: [name] | Raw confidence: X%
Fear & Greed: X (classification) | Sentiment edge: [BULLISH/BEARISH/NEUTRAL]
Learning boost: [+X% or -X% based on historical performance]
Adjusted confidence: X%

REASONING:
• Technical: [signal drivers — which indicators are aligned]
• Sentiment: [what Fear & Greed and market mood mean for this setup]
• News: [any live catalyst — bullish/bearish/none]
• Historical: [win rate on this setup, last 3 trades]
• Regime: [risk-on/off, VIX, cross-asset alignment]
• Invalidation: [the one thing that kills this setup]

TRADE PLAN:
Entry: $X | Stop: $X | Target: $X | R/R: 1:X | Risk: 1%

VERDICT: [TAKE IT / WAIT / SKIP]
Reason: [one sentence — the decisive factor]
---
