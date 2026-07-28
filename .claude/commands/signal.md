Fetch live signals and sentiment context. Usage: /signal

Use SmartEntry MCP tools directly — faster and more reliable than HTTP fetches.

Call in parallel:
  mcp__smartentry__get_signals        → BTC/Gold/SPX signals, confidence, entry/stop/target
  mcp__smartentry__get_risk_status    → regime, circuit breaker, session P&L, news blackout
  mcp__smartentry__get_healer         → system health

HTTP fallback only if MCP fails:
  GET http://localhost:3001/api/signals
  GET http://localhost:3001/api/risk-status

Report in this exact format:

**BTC**  — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X
**GOLD** — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X
**SPX**  — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X

Regime: [regime] | Session: [session] | Circuit breaker: [CLEAR/OPEN] | News blackout: YES/NO

Rules:
- If confidence < 65%: show WAIT, no trade levels
- If healer shows issues: "WARNING: [what's wrong]"
- No fluff. One line per asset.
