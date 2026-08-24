# Pre-flight Checklist — mandatory before ANY code change

This file is referenced by CLAUDE.md, builder.md, and build.md.
JARVIS must answer all 6 questions before writing a single line of code.
If any answer is "NO" or "UNSURE" — stop, investigate, then restart from question 1.

═══ 6 QUESTIONS — ANSWER ALL 6 ═══

Q1. HAVE I READ THE FULL FILE?
    → Read the ENTIRE file front to back. Not just the function. Not just the section.
    → If the file is > 2000 lines: read the full function + trace its callers (grep) + trace its callees.
    → Answer: "YES — [filename], [N] lines, read fully" or "NO — reading now"

Q2. DO I KNOW WHAT CALLS THIS FUNCTION?
    → Grep the codebase for the function name. List every caller.
    → If the function is called from 0 places: it may be dead code — confirm before editing.
    → If called from 3+ places: this is high-risk — say so before proceeding.
    → Answer: "Called from: [list] / Dead code / High-risk: [N] callers"

Q3. HAVE I WRITTEN THE SCAFFOLD?
    CHANGING: [exact function name] in [exact file path]
    NOW:      [what it does today — one sentence, specific]
    AFTER:    [what it will do — one sentence, specific]
    RISK:     [what breaks if wrong — name the specific thing, not "could cause issues"]

    → If RISK mentions: signal generation / risk gate / lot sizing / stop calculation / trade execution
    → STOP. Show the scaffold to the user. Do NOT write code until they say "go".

Q4. HAVE I TRACED 3 REAL VALUES?
    Value A (normal):  input=[X] → current code returns [Y] → after change returns [Z] → correct: YES/NO
    Value B (edge):    input=[X] → current code returns [Y] → after change returns [Z] → correct: YES/NO
    Value C (failure): input=[X] → current code returns [Y] → after change returns [Z] → correct: YES/NO

    → If any returns NO: redesign before writing code.

Q5. DO I KNOW HOW TO VERIFY IT WORKED?
    → Name the exact command to run after the edit:
      "node --check server/index.js && curl -s http://localhost:3001/api/[route] | node -e 'JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\"))'"
    → If server/index.js was changed: also "node tasks/api_snapshot.cjs"
    → If no verifiable endpoint exists: say so before proceeding.

Q6. IS THIS CHANGE IN SCOPE?
    → The task asked for: [what was requested]
    → This change does: [what the edit actually does]
    → Are they the same? YES / NO — if NO, stop and re-scope.
    → No extra cleanup, no refactoring "while I'm here", no bonus features.

═══ POST-FLIGHT — run after EVERY edit, before git commit ═══

□ node --check [file]  (JS)  OR  python -m py_compile [file]  (Python)  → must pass
□ Hit the relevant API endpoint — verify the response shape is correct, not just 200
□ node tasks/api_snapshot.cjs  (if server/index.js was changed) → must exit 0
□ grep -r "sk-ant-\|password=\|AKIA" [file] → must return empty
□ git diff [file]  → read the diff one more time before staging — confirm it matches the intent

Only after all 5 are green: git add [specific file] && git commit -m "[what and why]"

═══ THE MOST COMMON MISTAKES — memorise these ═══

1. Editing a file without reading the full context → introduces conflicts with existing logic
2. Assuming a function is only called from one place → breaks callers not checked
3. Declaring "done" after writing code, not after verifying it runs
4. Adding features beyond the task scope → scope creep introduces bugs
5. Skipping api_snapshot.cjs after server/index.js edits → shape regressions go undetected
6. Using git add -A → stages unrelated files (or another agent's half-written work)
7. Not tracing edge cases → null/undefined crashes in production
