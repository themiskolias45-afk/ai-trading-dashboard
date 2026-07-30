Parallel AI engineering for SmartEntry Pro. Usage: /engineer [task]

$ARGUMENTS is the task. You are the architect. Sub-agents build in parallel using the Agent tool.

═══ STEP 0 — SCOPE CHECK ═══
- Single file, single function → do it yourself, skip parallel
- 2+ independent components, no file overlap → use parallel agents below
- Touches signal logic OR risk gate OR lot sizing → show plan and wait for approval first

═══ STEP 1 — ARCHITECT ═══
Before spawning anything:
1. Read EVERY file that will be touched — full reads, front to back.
2. Identify 2–5 independent workstreams. Each must own SPECIFIC files with ZERO overlap.
3. Define the exact interface between them: function names, API routes, data shapes, return types.
4. Write the plan to tasks/engineer-plan.md — file ownership + interface contracts.
5. TaskCreate for each workstream. Set status: in_progress when spawning.

Only spawn after plan is written and every interface is defined.

═══ STEP 2 — SPAWN PARALLEL AGENTS ═══
Use the Agent tool to launch all workstreams simultaneously in a SINGLE response.
Each agent uses subagent_type: "builder". Pass a self-contained prompt per agent.

Each agent prompt must include:

```
SmartEntry Pro sub-engineer — one task, then stop.

TASK: [exactly what to build — specific, not vague]
YOUR FILES: [exact file paths — space separated]
TOUCH NOTHING ELSE.
INTERFACE CONTRACT: [function signatures / API shapes this agent must match]
VERIFY COMMAND: [node --check file.js OR python -m py_compile file.py]

MANDATORY STEPS IN ORDER:
1. Read every assigned file front to back before writing one line.
2. Write CHANGING/NOW/AFTER/RISK for each function you will edit.
   If RISK touches signal generation, risk gate, lot sizing, or stop logic → output
   "RISK-HIGH: [description]" and STOP. Do not implement.
3. Implement — minimal and correct. No abstractions beyond what the task requires.
4. Handle every failure: null, undefined, empty array, network timeout, file missing.
5. Run VERIFY COMMAND — if it fails, fix and re-run. Never continue with broken syntax.
6. Scan edited files for secrets (sk-ant-, AKIA, password=) — fix any found.
7. git add [only YOUR FILES] && git commit -m "engineer: [what was built]"
8. Run VERIFY COMMAND one final time on the committed code.

REPORT (required — exact format):
STATUS: DONE / BLOCKED / RISK-HIGH
BUILT: [one line]
VERIFIED: [exact output of verify command]
COMMITTED: [git hash]
RISK-NOTES: [anything to review, or NONE]
```

Launch all agents in ONE response turn. Do not wait for one before spawning the next.
Max 5 parallel agents.

═══ STEP 3 — VERIFY RESULTS ═══
For each agent that reports DONE:
1. Run node --check on every .js file it touched.
2. Run python -m py_compile on every .py file it touched.
3. git log --oneline -5 to confirm commit landed.
4. If agent reported BLOCKED → fix it yourself immediately.
5. If agent reported RISK-HIGH → review the specific concern, decide, then implement or reject.

═══ STEP 4 — INTEGRATE & SHIP ═══
1. Wire all components: import/require, route registration, data flows.
2. End-to-end test: curl the affected API endpoints, verify response shape.
3. git commit -m "engineer: integrate [what was built]"
4. TaskUpdate all workstreams to completed.
5. Final report: what was built, what was verified, what remains.

═══ RULES ═══
- Plan first. Never spawn without tasks/engineer-plan.md written.
- Zero file overlap between agents — conflicts destroy work.
- Every agent verifies its own syntax before committing.
- Signal/risk/lot/stop logic always requires explicit approval before implementation.
- If any agent produces broken syntax: fix before moving on.
- Code-reviewer agent runs automatically on any server/index.js changes.
