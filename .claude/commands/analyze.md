Deep single-symbol analysis with live sentiment + news. Usage: /analyze BTC | /analyze GOLD | /analyze SPX

$ARGUMENTS is the symbol. If blank, analyze all three.

═══ MANDATORY: READ CODE BEFORE DESCRIBING BEHAVIOR ═══
Before stating what any setup does or generating a confidence adjustment:
  Grep server/index.js for the setup name (e.g. "MOMENTUM", "BUY_OVERSOLD", "SQUEEZE")
  Read the matching function block — do not describe behavior from API field names or memory.
  If the grep returns no match, say "setup not found in server/index.js" — do not invent behavior.

═══ MANDATORY: SAMPLE FLOOR ═══
Before reporting any win rate or learning boost:
  Check the trade count (n) for this setup from get_learning or analyze_symbol.
  n < 5  → "INSUFFICIENT EVIDENCE (n=[N]) — do not report WR as meaningful"
           Set learning boost to 0. Do not adjust confidence from WR.
  n 5-19 → "EARLY DATA (n=[N]) — treat WR as directional, not settled"
  n ≥ 20 → report normally

═══ STEP 1 — Get all data in parallel ═══
  mcp__smartentry__analyze_symbol symbol=[SYMBOL]   → compound analysis (signals + learning + journal in 1 call)
  mcp__smartentry__get_risk_status                  → regime, circuit breaker
  mcp__smartentry__read_memory query=[SYMBOL]       → any stored lessons for this asset
  Brave search: "[SYMBOL] price analysis today [date]"
  Brave search: "[SYMBOL] news today"

═══ STEP 2 — Reason through all data ═══
  mcp__sequential-thinking (or think step by step):
  - What is the technical signal saying? (RSI/MACD/BB/EMA alignment)
  - What does Fear & Greed = X mean for this trade?
  - Are there news catalysts that support or invalidate the setup?
  - What is the historical win rate? (Apply sample floor above — n<5 = omit)
  - Last 5 trades on this symbol — any streak?
  - Is the market regime favorable? (VIX, DXY, cross-asset)
  - Exact entry, stop, target and R:R?
  - What single event would immediately invalidate this setup?
  - Final verdict: TAKE IT / WAIT / SKIP

═══ STEP 3 — Output ═══
---
DEEP ANALYSIS — [SYMBOL] — [timestamp]
---
Signal: [LONG/SHORT/WAIT] | Setup: [name] | Raw confidence: X%
Learning: [WR on N trades — or INSUFFICIENT EVIDENCE if n<5] | Adjusted confidence: X%

REASONING:
• Technical:    [signal drivers — which indicators aligned — from server/index.js code, not field names]
• Sentiment:    [Fear & Greed reading and what it means]
• News:         [any live catalyst or NONE]
• Historical:   [win rate on this setup, last 3 trades — only if n≥5]
• Regime:       [risk-on/off, VIX, cross-asset]
• Invalidation: [the one thing that kills this setup]

TRADE PLAN:
Entry: $X | Stop: $X | Target: $X | R/R: 1:X | Risk: 1%

VERDICT: [TAKE IT / WAIT / SKIP]
Reason: [one sentence — the decisive factor]
---
