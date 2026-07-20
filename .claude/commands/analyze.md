Deep single-symbol analysis. Usage: /analyze BTC  or  /analyze GOLD  or  /analyze SPX

$ARGUMENTS is the symbol. If blank, analyze all three.

Do this in order:
1. Fetch http://localhost:3001/api/signals — get current signal + reasoning
2. Fetch http://localhost:3001/api/learning — get historical win rate for this setup
3. Fetch http://localhost:3001/api/journal — last 20 trades, filter for this symbol
4. Use sequential thinking to reason: is this a good trade RIGHT NOW?

Sequential thinking questions to work through:
- What is the signal saying and why?
- What is the win rate on this setup historically?
- What did the last 5 trades on this symbol look like?
- Is the current market regime favorable?
- What is the exact entry, stop, target and why those levels?
- What could invalidate this setup?
- Final verdict: TAKE IT / WAIT / SKIP and why

Output format:
---
DEEP ANALYSIS — [SYMBOL] — [timestamp]
---
Signal: [LONG/SHORT/WAIT] | Setup: [name] | Raw confidence: X%
Learning boost: [+X% or -X% based on historical performance]
Adjusted confidence: X%

REASONING:
[4-6 bullet points from sequential thinking — the actual logic]

TRADE PLAN:
Entry: $X | Stop: $X | Target: $X | R/R: 1:X | Risk: 1%

VERDICT: [TAKE IT / WAIT / SKIP]
Reason: [one sentence]
---
