Build a new feature for SmartEntry Pro with full quality gates.

Usage: /build [description of what to build]
If $ARGUMENTS is empty, ask: "What do you want to build?"

═══ STEP 1 — CHECK IF IT EXISTS ═══
  Search server/index.js for the feature using Grep.
  Search dashboard/index.html for any UI component.
  If it exists → show what's there, ask: "Improve the existing one? (Y/N)"

═══ STEP 2 — SCOPE ═══
  Ask ONE clarifying question if anything is ambiguous.
  Then write a build plan:
    FILES:    [exactly which files will be created or modified]
    WHAT:     [what the feature does — 2 sentences max]
    API:      [new endpoint(s) if any — method, path, request, response shape]
    UI:       [what changes in the dashboard if any]
    RISK:     [what could break in the existing system]
  Wait for approval before proceeding.

═══ STEP 3 — READ BEFORE TOUCHING ═══
  Read EVERY file in the build plan — full content, front to back.
  For server/index.js: understand the existing route structure, middleware, error patterns.
  For dashboard files: understand the existing fetch/render pattern.
  If any file is too large to hold fully in context, read the relevant section and say so.

═══ STEP 4 — BUILD ═══
  For each file, in order:
    a) Write/edit the file
    b) Run node --check [file] (JS) or python -m py_compile [file] (Python) — fix before continuing
    c) Scan for secrets (sk-ant-, AKIA, password=) — fix before continuing
    d) git add [specific file] && git commit -m "[what was built]"

  Multi-file work (3+ files): create a TaskCreate task first, update status at each file.

═══ STEP 5 — TEST ═══
  After building, verify it actually works:
  - New API endpoint → curl or mcp__fetch to hit it, confirm 200 and correct JSON shape
  - Changed signal logic → trace with confidence=65, 64, 100, 0
  - New dashboard element → confirm data appears at the endpoint it fetches from
  - If a test file exists (server/tests/) → run it

  If anything fails → fix it before reporting done. Never report done on untested code.

═══ STEP 6 — REVIEW ═══
  If server/index.js was modified → invoke code-reviewer agent on the changed function(s).
  Fix any CRITICAL findings before declaring the feature complete.

═══ STEP 7 — REPORT ═══
BUILT: [feature name]
---
Files changed: [list with one-line description each]
Endpoints added: [list]
Tested: [what was verified and how]
Commits: [list with hashes]
What to do next: [one sentence]
