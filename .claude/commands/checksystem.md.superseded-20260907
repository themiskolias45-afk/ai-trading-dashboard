Full system diagnostic — all components + learning + performance. Usage: /checksystem

Use SmartEntry MCP tools directly.

Call in parallel:
  mcp__smartentry__get_signals        → current signals + confidence per asset
  mcp__smartentry__get_risk_status    → regime, P&L, consecutive losses, halt status
  mcp__smartentry__get_healer         → 6-point health check
  mcp__smartentry__get_learning       → setup win rates + boosts + calibration
  mcp__smartentry__get_performance    → total trades, WR, best/worst setup, equity

HTTP fallback if MCP fails:
  GET http://localhost:3001/api/checksystem

Report:

SYSTEM CHECK — [timestamp]
══════════════════════════
SERVER:  [ONLINE / OFFLINE] | Uptime: Xh Xm | Healer: X/6 green
SIGNALS: BTC:[signal conf%] GOLD:[signal conf%] SPX:[signal conf%] (updated X min ago)
RISK:    Daily P&L $X | Consecutive losses: X | Halted: YES/NO | Regime: [regime]

PERFORMANCE:
• Total trades: X | Win rate: X% | Total P&L: $X
• Recent form: [last 5 trade results — flag if ≥3 losses]

SELF-LEARNING (X sessions):
• [SETUP]: X% WR → [BOOSTED +X / PENALISED -X / LEARNING / NEUTRAL]

CONFIDENCE CALIBRATION:
• 65-74%: X% actual WR [GOOD if close to 70%, OVERCONFIDENT if much lower]
• 75-84%: X% actual WR
• 85%+:   X% actual WR

IMPROVEMENT PROPOSAL:
• [if worstSetup WR < 50%: show it and ask "Fix now?"]

VERDICT: [ONE LINE — is the system healthy and what's the main concern]
