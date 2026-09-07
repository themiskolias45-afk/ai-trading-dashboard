Autonomous bug finder and fixer. Usage: /fix [bug description] | /fix --scan

$ARGUMENTS: describe the bug, or use --scan to find bugs automatically.

═══ MODE A: TARGETED FIX (/fix [description]) ═══

1. LOCATE
   - Read the error message / description carefully
   - Identify which file and function is responsible
   - Read the FULL file front to back — never edit blind

2. TRACE
   - Use sequential thinking to trace root cause
   - Work backwards from the symptom: what input caused this? what returned wrong?
   - Find the EXACT line that is wrong — not a symptom, the cause

3. FIX
   - Write the minimal fix — do not touch unrelated code
   - Walk through the fix mentally with the inputs that caused the bug
   - Check: does this fix break any other caller of this function?
   - Handle edge cases: what if the input is null, empty, or undefined?

4. VERIFY
   - Run node --check [file] or python -m py_compile [file]
   - Hit the relevant API endpoint — verify response shape is correct, not just 200
   - Confirm the fix produces the correct output for normal, edge, and null cases
   - If server/index.js was changed: node tasks/api_snapshot.cjs → must exit 0 (exit 1 = shape regression, fix before commit)
   - If server/index.js was changed: invoke code-reviewer agent on the changed function — fix all CRITICAL findings before commit

5. COMMIT
   - git add [specific file only]
   - git commit -m "fix: [what was broken — one line root cause]"

6. REPORT
   - What was broken: [one line]
   - Root cause: [one line]
   - Fix applied: [one line]
   - Verified: [how it was confirmed]

═══ MODE B: SCAN AND FIX (/fix --scan) ═══

1. Run /check (inline, without Python scripts) to find all failures
2. Run /verify to check data freshness and signal integrity
3. For each issue found, classify:
   - LOW RISK (syntax error, missing null check, wrong status code) → fix immediately, commit
   - MEDIUM RISK (logic change, adding a filter, API modification) → show diff, ask approval
   - HIGH RISK (signal engine, risk gate, trade execution logic) → describe only, never auto-apply

4. After each fix: re-run the specific check to confirm resolved
5. Loop until all LOW RISK issues are fixed

6. REPORT
   AUTO-FIXED: [list with commit hashes]
   AWAITING APPROVAL: [list with proposed diffs]
   MANUAL REQUIRED: [list — too risky to auto-apply]

═══ RULES ═══
- Before any edit: read tasks/pre-flight.md and answer all 6 questions
- Root cause only — never patch symptoms
- Read the FULL file before touching it
- One fix per commit with a clear message
- NEVER auto-apply fixes to: generateSignalMTF, risk gate, trade execution, confidence scoring
- Always verify the fix works before moving to the next issue
- If a fix is unclear after 2 attempts, stop and ask
