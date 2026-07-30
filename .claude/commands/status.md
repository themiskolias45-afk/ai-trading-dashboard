Quick one-screen system status. Usage: /status

Gather in parallel (MCP tools — no HTTP):
  mcp__smartentry__get_signals
  mcp__smartentry__get_risk_status
  mcp__smartentry__get_healer

Also run immediately:
  node --check server/index.js  (syntax)
  git status --porcelain        (dirty files)

Output in exactly this format — one line per item, no prose:

STATUS — [HH:MM]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SERVER   [ONLINE / OFFLINE]  uptime [Xh Xm]    healer [X/6]
REGIME   [regime]  session [session]  halted [YES/NO]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BTC      [SIGNAL/WAIT] [confidence]%  [if WAIT: gap Xpt | last trade Nd ago]  [if SIGNAL: entry $X  stop $X]
GOLD     [SIGNAL/WAIT] [confidence]%  [if WAIT: gap Xpt | last trade Nd ago]  [if SIGNAL: entry $X  stop $X]
SPX      [SIGNAL/WAIT] [confidence]%  [if WAIT: gap Xpt | last trade Nd ago]  [if SIGNAL: entry $X  stop $X]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RISK     daily P&L $X  consecutive losses [X]  open risk [X]%
CODE     [CLEAN / SYNTAX ERROR in [file]]
GIT      [CLEAN / X files uncommitted]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACTION   [one sentence — the one thing that needs attention right now, or "Nothing — all clear"]

Rules:
- If server is offline: ACTION = "Start server: tasks\menu.bat option S"
- If healer < 4/6: ACTION = "Force heal: POST /api/healer/heal"
- If any confidence ≥ 65 and not halted: ACTION = "SIGNAL READY: [asset] [direction]"
- If syntax error: ACTION = "SYNTAX ERROR — run /debug"
- If consecutive losses = 3: ACTION = "CIRCUIT BREAKER — trading halted"
- If git dirty: ACTION = "Uncommitted changes — run git commit"
