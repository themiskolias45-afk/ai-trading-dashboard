Comprehensive end-to-end verification of the entire SmartEntry Pro system. Usage: /verify

This is the definitive health check — runs everything and gives a single pass/fail verdict.
Run after every major change. Run before going live. Run when something feels wrong.

═══ 1. SYNTAX — all code files ═══
  node --check server/index.js                    → must pass
  node --check server/mcp_server.js (if exists)   → must pass
  python -m py_compile [each .py file]            → must pass all

═══ 2. SECURITY — secrets never leak ═══
  git ls-files server/apikey.txt → must be empty
  git ls-files keys.env → must be empty
  git ls-files *.env → must be empty
  Grep server/index.js for 'sk-ant-' → must find nothing
  Check .gitignore has apikey.txt, keys.env, *.env

═══ 3. SERVER — all endpoints responding ═══
Fetch in parallel (timeout 8s each):
  GET /api/health      → 200 OK
  GET /api/signals     → JSON with btc, gold, spx objects
  GET /api/prices      → JSON with price data
  GET /api/risk-status → JSON with regime, circuitBreaker
  GET /api/healer      → JSON with checks object
  GET /api/sentiment   → JSON with fearGreed number

═══ 4. DATA FRESHNESS ═══
  /api/signals: check updatedAt — must be within last 30 min
  /api/sentiment: check updated — must be within last 2 hours
  /api/healer: check how many checks are green (expect 6/6)

═══ 5. SIGNAL INTEGRITY ═══
  For each asset (BTC, Gold, SPX):
  - signal is one of: BUY, SELL, WAIT
  - confidence is 0–100
  - if signal != WAIT: entry, stop, target are all present and logical (stop < entry < target for BUY)

═══ 6. GIT STATE ═══
  git branch — on correct branch
  git status — no uncommitted changes to server/index.js or dashboard/
  git log --oneline -3 — last 3 commits look reasonable

═══ REPORT FORMAT ═══

VERIFICATION REPORT — [timestamp]
══════════════════════════════════
1. SYNTAX    [PASS / FAIL — X files failed]
2. SECURITY  [PASS — clean / ESCALATE — [file] tracked]
3. SERVER    [X/6 endpoints OK]
4. DATA      [signals fresh: YES/NO | healer: X/6 | sentiment: fresh YES/NO]
5. SIGNALS   [BTC=[sig conf%] GOLD=[sig conf%] SPX=[sig conf%] — all valid: YES/NO]
6. GIT       [branch: [name] | dirty: YES/NO]

ISSUES FOUND:
  [numbered list of every failure — exact problem on one line]

OVERALL: GREEN — fully operational / YELLOW — degraded / RED — system down

If YELLOW or RED: "Fix issue [1] first? (Y/N)"
If GREEN: "Verification passed — [N] checks, 0 issues. System ready."
