Show what the self-learning engine has learned. Usage: /selflearn

Use SmartEntry MCP tools directly.

Call:
  mcp__smartentry__get_learning    → setup win rates, boosts, calibration, sessions count

HTTP fallback:
  GET http://localhost:3001/api/learning

Report:

SELF-LEARNING REPORT
Sessions run: X | Last updated: [date]

SETUP PERFORMANCE (learned from real trades):
┌─────────────────────┬──────┬──────┬────────┬────────┬──────────────┐
│ Setup               │ Wins │ Loss │ WR %   │ P&L    │ Status       │
├─────────────────────┼──────┼──────┼────────┼────────┼──────────────┤
│ [each setup]        │  X   │  X   │  X%    │ $X     │ [BOOSTED /   │
│                     │      │      │        │        │  PENALISED / │
│                     │      │      │        │        │  LEARNING]   │
└─────────────────────┴──────┴──────┴────────┴────────┴──────────────┘

WHAT THE SYSTEM LEARNED:
• [plain English — which setups are hot, which are losing edge]

SETUPS STILL LEARNING (< 5 trades): [list or "none"]
SETUPS TO DISABLE (WR < 40% over 5+ trades): [list or "none"]

Ask: "Disable a weak setup, reset learning, or see full journal?"
