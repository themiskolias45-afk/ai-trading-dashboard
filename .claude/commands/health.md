Run a full system health check on SmartEntry Pro using the deep error checker.

Run:
```
python check_errors.py
```

Then fetch for live status:
- GET http://localhost:3001/api/healer
- GET http://localhost:3001/api/risk-status
- GET http://localhost:3001/api/signals

Report in this format:

SYSTEM HEALTH — [timestamp]
══════════════════════════
SERVER:    [ONLINE / OFFLINE] | Uptime: Xh Xm | Healer: X/6 checks green
SIGNALS:   BTC=[signal] GOLD=[signal] SPX=[signal]
RISK:      [regime] | Session: [session] | Circuit breaker: [open/closed]
MODE:      [auto / semi-auto]
SYNTAX:    [X JS files clean / X Python files clean — or list any failures]
SECURITY:  [secrets gitignored: YES / NO — escalate immediately if NO]
GIT:       [branch correct: YES / NO]

FAILURES: [list any — these block trading]
WARNINGS: [list any — review but not blocking]

VERDICT: [GREEN — system healthy / YELLOW — warnings present / RED — failures found]

If RED: state the exact problem and ask "Fix now? (Y/N)"
If GREEN: "All checks passed — system ready to trade."
