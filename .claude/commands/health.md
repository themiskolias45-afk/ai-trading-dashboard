Full system health check. Usage: /health

Run ALL of these directly — do not depend on Python scripts succeeding.

═══ STEP 1 — LIVE API STATUS (in parallel) ═══
  GET http://localhost:3001/api/health       → uptime, version
  GET http://localhost:3001/api/signals      → BTC/Gold/SPX signals + confidence
  GET http://localhost:3001/api/risk-status  → regime, circuit breaker, session P&L
  GET http://localhost:3001/api/healer       → healer checks (expect 6 green)
  GET http://localhost:3001/api/sentiment    → Fear & Greed score + updated timestamp

If server is offline (connection refused): "SERVER OFFLINE — run tasks\menu.bat option S to restart"

═══ STEP 2 — SYNTAX CHECK ═══
  node --check server/index.js → report pass or exact error
  node --check server/mcp_server.js (if file exists)

═══ STEP 3 — SECURITY CHECK ═══
  git ls-files server/apikey.txt → must be empty
  git ls-files keys.env → must be empty

═══ STEP 4 — GIT STATE ═══
  git branch (current branch)
  git status --short (uncommitted files)

═══ REPORT FORMAT ═══

SYSTEM HEALTH — [timestamp]
════════════════════════════
SERVER:    [ONLINE | OFFLINE] | Uptime: Xh Xm
SIGNALS:   BTC=[signal conf%] GOLD=[signal conf%] SPX=[signal conf%] (updated X min ago)
RISK:      [regime] | P&L today: $X | Losses in a row: X | Halted: YES/NO
HEALER:    [X/6 checks green]
SENTIMENT: Fear & Greed [score] ([classification]) | updated [X] min ago
SYNTAX:    [PASS / FAIL — filename: error]
SECURITY:  [CLEAN / ESCALATE — secret file tracked]
GIT:       branch=[name] | uncommitted=[count or CLEAN]

FAILURES:
  [numbered list — exact problem + one-line fix]

VERDICT: GREEN / YELLOW / RED

GREEN  → "System healthy — ready to trade."
YELLOW → "Warnings present — review before trading."
RED    → "System degraded — [top failure]. Fix now?"
