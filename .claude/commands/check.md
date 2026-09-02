Deep system check — syntax, security, API health, git. Usage: /check [syntax|security|api|git]

$ARGUMENTS selects scope. If blank, runs everything.

Do NOT rely on Python scripts. Run all checks directly.

═══ SYNTAX CHECK ═══
Check these files (use Bash tool directly):
  node --check server/index.js
  node --check server/mcp_server.js

Find and check all Python files:
  python -m py_compile [each .py file in project root]

Collect every file that fails — report the exact error message.

═══ CLAIMS CHECK ═══
  node tasks/claims_check.cjs

Verifies what CLAUDE.md ASSERTS against what the code and live system DO —
line-number citations, every /api path against registered routes, named code
files, forbidden strings, and the live gate against /api/strategy-settings.

exit 0 = claims hold | exit 1 = STALE claims | exit 2 = the checker broke

Report every STALE finding with its suggested fix. Do NOT treat UNVERIFIABLE as
a failure — an offline server and runtime-generated data files are expected to
be unverifiable and are not drift.

This matters more than it looks: CLAUDE.md is loaded at the start of every
session, so a wrong fact there is not one bad answer, it is a bad premise under
every answer that follows.

═══ SECURITY CHECK ═══
1. git ls-files server/apikey.txt
   → If non-empty: ESCALATE — "SECRET TRACKED IN GIT: git rm --cached server/apikey.txt"
2. git ls-files keys.env
   → If non-empty: ESCALATE — "SECRET TRACKED IN GIT: git rm --cached keys.env"
3. Read .gitignore — must contain: server/apikey.txt, keys.env, *.env
4. Grep server/index.js for literal API key patterns (sk-ant-, AKIA) — must find none

═══ API HEALTH ═══
Fetch these in parallel (timeout 5s each):
  GET http://localhost:3001/api/health
  GET http://localhost:3001/api/signals
  GET http://localhost:3001/api/risk-status
  GET http://localhost:3001/api/healer
  GET http://localhost:3001/api/sentiment

Mark each PASS (200 + valid JSON) or FAIL (error/timeout/wrong shape).

═══ GIT CHECK ═══
  git branch (verify on correct branch)
  git status --short (uncommitted changes)
  git ls-files --others --exclude-standard (untracked files)

═══ REPORT FORMAT ═══

SYSTEM CHECK — [timestamp]
══════════════════════════
SYNTAX    [PASS — X files clean / FAIL — list each file + error]
SECURITY  [PASS — secrets protected / ESCALATE — file tracked in git]
API       [X/5 endpoints healthy — list any failures]
GIT       branch: [name] | uncommitted: [count or CLEAN]

FAILURES (fix before trading):
  1. [exact problem] → [exact fix]

WARNINGS:
  [anything worth noting but not blocking]

VERDICT: GREEN / YELLOW / RED

If RED: "Fix required. Fix now?"
If GREEN: "System clean — [X] checks, 0 failures."
