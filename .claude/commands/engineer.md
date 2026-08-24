Parallel AI engineering for SmartEntry Pro. Usage: /engineer [task]

$ARGUMENTS is the task. You are the architect. Sub-agents build in parallel using the Agent tool.

═══ STEP 0 — SCOPE CHECK ═══
- Single file, single function → do it yourself, skip parallel
- 2+ independent components, no file overlap → use parallel agents below
- Touches signal logic OR risk gate OR lot sizing → show plan and wait for approval first

═══ STEP 1 — ARCHITECT ═══
Before spawning anything:
0. Run `node tasks/ai_brief.cjs` and read it. Section 4 names the OPEN questions and
   the live constraint; section 5 names what is already settled. Building something
   section 5 has already measured as having no edge is wasted parallelism, and
   spending five agents on polish while section 4 lists an unanswered gate question
   is the expensive version of the same mistake. If the task contradicts a settled
   claim, say so before spawning.
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
EXPECTED OUTPUT SCHEMA: [exact JSON shape this agent must return in its REPORT — e.g. {status, built, verified, committed, riskNotes}]

MANDATORY STEPS IN ORDER:
1. Read every assigned file front to back before writing one line.
2. Write CHANGING/NOW/AFTER/RISK for each function you will edit.
   If RISK touches signal generation, risk gate, lot sizing, or stop logic → output
   "RISK-HIGH: [description]" and STOP. Do not implement.
3. Implement — minimal and correct. No abstractions beyond what the task requires.
4. Handle every failure: null, undefined, empty array, network timeout, file missing.
5. Run VERIFY COMMAND — if it fails, fix and re-run. Never continue with broken syntax.
6. Scan edited files for secrets (sk-ant-, AKIA, password=) — fix any found.
7. Commit with an explicit PATHSPEC and no `git add`:

       git commit -m "engineer: [what was built]" -- [YOUR FILES]

   NEVER `git add` and never a bare `git commit`. You are one of up to five agents
   working in the SAME working tree, and the git index is shared between all of
   you. `git add` stages into that shared index, and a bare `git commit` then
   commits EVERYTHING staged in it — including another agent's half-written file,
   mid-edit, that never ran a syntax check. The other agent's own commit then finds
   nothing to commit and reports a hash that does not contain its work. The pathspec
   form above commits only the paths you name and ignores the index entirely.
   If you hit `.git/index.lock`, another agent is mid-commit: wait 2s and retry once.
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
1. Validate the agent's report matches the EXPECTED OUTPUT SCHEMA — if fields are missing, treat as BLOCKED.
2. Run node --check on every .js file it touched.
3. Run python -m py_compile on every .py file it touched.
4. git log --oneline -5 to confirm commit landed.
5. Run node tasks/api_snapshot.cjs if any server/index.js was changed — shape regression check.
6. If agent reported BLOCKED → fix it yourself immediately.
7. If agent reported RISK-HIGH → review the specific concern, decide, then implement or reject.

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

═══ WORKTREE ISOLATION (use when agents MUST touch the same file) ═══
Standard parallel agents share the working tree — zero file overlap is the rule.
If two workstreams genuinely cannot avoid the same file (e.g. both need server/index.js):
  → Use isolation: "worktree" in the Agent tool call
  → Each agent gets its own git branch, edits in isolation, no index lock conflicts
  → After both finish: cherry-pick or merge the two branches manually
  → Cost: ~500ms extra setup per agent + disk space
  → Use only when overlap is unavoidable — the extra merge step is real work.
Default is shared tree with strict pathspec commits. Worktree is the escape hatch.
