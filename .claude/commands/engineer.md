Spawn real parallel Claude sub-agents to build complex systems simultaneously. Usage: /engineer [task]

$ARGUMENTS is the task. You are the architect and integrator. Sub-agents build in parallel.

═══ STEP 0 — DECIDE ═══
Is this actually parallel work?
- 1 file, 1 feature → do it yourself directly, skip the rest
- 2+ independent components with no file overlap → use parallel agents

═══ STEP 1 — ARCHITECT FIRST ═══
Before spawning anything:
1. Read EVERY file that will be touched — full reads, no skimming
2. Break into independent workstreams (2–5 max)
3. Each workstream must own SPECIFIC FILES with ZERO overlap
4. Define the exact interface between components (function names, API routes, data shapes)
5. Write the plan to tasks/engineer-plan.md — include file ownership and interface contracts
6. Create a TaskCreate for each workstream

Only spawn after the plan is written and every interface is defined.

═══ STEP 2 — SPAWN PARALLEL AGENTS ═══
Each agent prompt MUST include built-in quality gates:

```powershell
$workstreams = @(
  @{
    name  = "agent1"
    files = "[exact files — space separated]"
    task  = "[exactly what to build]"
    check = "[exact verify command: e.g. node --check server/index.js]"
  },
  @{
    name  = "agent2"
    files = "[different files — no overlap with agent1]"
    task  = "[exactly what to build]"
    check = "[verify command]"
  }
)

$jobs = @()
foreach ($ws in $workstreams) {
    $prompt = @"
SmartEntry Pro sub-engineer. Single task, then stop.

TASK: $($ws.task)
YOUR FILES: $($ws.files)
TOUCH NOTHING ELSE.

MANDATORY STEPS IN ORDER:
1. Read EVERY assigned file front to back before touching anything.
2. Build the feature — minimal, correct, no bloat.
3. Handle every failure case: null, empty, network down, file missing.
4. After editing: run $($ws.check) — fix any error before proceeding.
5. Scan for hardcoded secrets (sk-ant-, password=, apikey=) — use env vars only.
6. git add $($ws.files) — only your files.
7. git commit -m 'engineer: [what you built]'
8. Run $($ws.check) one final time to confirm the committed code is clean.

REPORT FORMAT (required):
STATUS: DONE / BLOCKED
BUILT: [one line what was implemented]
VERIFIED: [result of check command]
COMMITTED: [git hash]
ISSUES: [any problems found, or NONE]

If BLOCKED: explain exactly why and what you need.
"@
    $jobs += Start-Job -Name $ws.name -ScriptBlock {
        param($p)
        Set-Location 'C:\Users\User\ai-trading-dashboard'
        & claude -p $p --dangerously-skip-permissions 2>&1
    } -ArgumentList $prompt
}

Write-Host "[$($jobs.Count) agents running in parallel]"
$jobs | Wait-Job | Out-Null
$results = @{}
$jobs | ForEach-Object { $results[$_.Name] = Receive-Job $_; Remove-Job $_ }
$results.GetEnumerator() | ForEach-Object { Write-Host "=== $($_.Key) ==="; Write-Host $_.Value }
Write-Host "[All agents complete — now verifying]"
```

═══ STEP 3 — VERIFY EVERY AGENT ═══
For each agent result:
1. Did it report DONE or BLOCKED?
2. Run: node --check on every .js file touched
3. Run: python -m py_compile on every .py file touched
4. git log --oneline -10 to see what each agent committed
5. If BLOCKED or broken code: fix it yourself immediately — never ship broken work

═══ STEP 4 — INTEGRATE & TEST ═══
1. Wire all components together
2. Test end-to-end: curl key endpoints, verify data flows correctly
3. Final commit: "engineer: integrate [what was built]"
4. Update all tasks to COMPLETED
5. Report: what was built, verified, and committed

═══ RULES ═══
- Never spawn without tasks/engineer-plan.md written first
- Each agent owns specific files — zero overlap
- Every agent must verify its own work before committing
- If any agent produces broken syntax: fix before moving on
- Never auto-apply changes to signal engine or risk management without approval
- Max 5 parallel agents
