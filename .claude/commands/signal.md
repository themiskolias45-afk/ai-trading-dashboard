Fetch live signals and sentiment context. Usage: /signal

Use SmartEntry MCP tools directly — faster and more reliable than HTTP fetches.

Call in parallel:
  mcp__smartentry__get_signals        → BTC/Gold/SPX signals, confidence, entry/stop/target
  mcp__smartentry__get_risk_status    → regime, circuit breaker, session P&L, news blackout
  mcp__smartentry__get_healer         → system health

HTTP fallback only if MCP fails:
  GET http://localhost:3001/api/signals
  GET http://localhost:3001/api/risk-status

Also get last trade date per asset from: mcp__smartentry__get_journal limit=50

Report in this exact format:

**BTC**  — [SIGNAL/WAIT] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X
**GOLD** — [SIGNAL/WAIT] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X
**SPX**  — [SIGNAL/WAIT] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X

Regime: [regime] | Session: [session] | Circuit breaker: [CLEAR/OPEN] | News blackout: YES/NO

GAP ANALYSIS (for each asset showing WAIT):
  **[ASSET]**: conf [X]% — needs [65-X]pt more to fire | last traded [N] days ago
  Daily: [BUY/SELL/WAIT] | H4: [BUY/SELL/WAIT] | missing: [what agreement is needed]
  If conf ≥ 60%: "CLOSE — [what market condition would push it over threshold]"
  If conf < 50%: "FAR — market flat on all timeframes"
  If no trade > 7 days: "⚠ SIGNAL-DEAD — run /diagnose"

Rules:
- If confidence ≥ 65%: show SIGNAL with full trade levels (no gap analysis needed)
- If confidence < 65%: show WAIT + gap analysis line
- If healer shows issues: "WARNING: [what's wrong]"
- No fluff. Data only.
