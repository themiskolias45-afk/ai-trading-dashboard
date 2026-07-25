Full market sentiment analysis — Fear & Greed, news, macro context.

Do all of this in order:

1. Fetch http://localhost:3001/api/sentiment — Fear & Greed score + classification
2. Fetch http://localhost:3001/api/signals — current confidence levels per asset
3. Fetch http://localhost:3001/api/prices — BTC/Gold/SPX/DXY/VIX
4. Brave search: "crypto market sentiment today [date]"
5. Brave search: "gold SPX market outlook this week"
6. Exa search: "Fear Greed index trading strategy extreme readings"

Synthesize all sources and report:

---
SENTIMENT BRIEF — [timestamp]
---

FEAR & GREED INDEX: [score] / 100 — [EXTREME FEAR / FEAR / NEUTRAL / GREED / EXTREME GREED]
Historical context: [what this reading has historically meant for price action]

MARKET SNAPSHOT:
• BTC:  $[price] ([24h change]%) | Signal: [direction] [conf]%
• Gold: $[price] ([24h change]%) | Signal: [direction] [conf]%
• SPX:  [price] ([24h change]%) | Signal: [direction] [conf]%
• VIX:  [value] ([risk-on / risk-off])
• DXY:  [value] ([dollar strength interpretation])

SENTIMENT EDGE:
• [How current Fear & Greed reading affects each asset — contrarian or confirms signal]
• [Key news catalyst or risk event this week]
• [Macro regime: risk-on / risk-off / transitioning]

TRADING IMPLICATION:
• BTC:  [FAVOR BUY / FAVOR SELL / NEUTRAL — one sentence why]
• Gold: [FAVOR BUY / FAVOR SELL / NEUTRAL — one sentence why]
• SPX:  [FAVOR BUY / FAVOR SELL / NEUTRAL — one sentence why]

BEST TRADE THIS WEEK: [asset] [direction] — [one sentence rationale]
---
