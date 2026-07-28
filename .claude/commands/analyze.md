Deep single-symbol analysis with live sentiment + news. Usage: /analyze BTC | /analyze GOLD | /analyze SPX

$ARGUMENTS is the symbol. If blank, analyze all three.

Use SmartEntry MCP tools — single call covers most data:

STEP 1 — Get all data in parallel:
  mcp__smartentry__analyze_symbol symbol=[SYMBOL]   → compound analysis (signals + learning + journal in 1 call)
  mcp__smartentry__get_risk_status                  → regime, circuit breaker
  mcp__smartentry__read_memory query=[SYMBOL]       → any stored lessons for this asset
  Brave search: "[SYMBOL] price analysis today [date]"
  Brave search: "[SYMBOL] news today"

STEP 2 — Reason through all data with sequential thinking:
  mcp__sequential-thinking (or think step by step):
  - What is the technical signal saying? (RSI/MACD/BB/EMA alignment)
  - What does Fear & Greed = X mean for this trade?
  - Are there news catalysts that support or invalidate the setup?
  - What is the historical win rate? Improving or degrading?
  - Last 5 trades on this symbol — any streak?
  - Is the market regime favorable? (VIX, DXY, cross-asset)
  - Exact entry, stop, target and R:R?
  - What single event would immediately invalidate this setup?
  - Final verdict: TAKE IT / WAIT / SKIP

STEP 3 — Output:
---
DEEP ANALYSIS — [SYMBOL] — [timestamp]
---
Signal: [LONG/SHORT/WAIT] | Setup: [name] | Raw confidence: X%
Learning boost: [+X% or -X% from historical WR] | Adjusted confidence: X%

REASONING:
• Technical:    [signal drivers — which indicators aligned]
• Sentiment:    [Fear & Greed reading and what it means]
• News:         [any live catalyst or NONE]
• Historical:   [win rate on this setup, last 3 trades]
• Regime:       [risk-on/off, VIX, cross-asset]
• Invalidation: [the one thing that kills this setup]

TRADE PLAN:
Entry: $X | Stop: $X | Target: $X | R/R: 1:X | Risk: 1%

VERDICT: [TAKE IT / WAIT / SKIP]
Reason: [one sentence — the decisive factor]
---
