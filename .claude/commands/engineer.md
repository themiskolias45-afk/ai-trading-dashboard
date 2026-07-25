Spawn real parallel Claude sub-agents to build complex systems simultaneously. Usage: /engineer [task]

$ARGUMENTS is the task. You are the architect and integrator. Sub-agents build in parallel.

═══ STEP 1 — ARCHITECT FIRST ═══
Before spawning anything, design the full system:
1. Break the task into independent workstreams (2–6 max)
2. Each workstream owns specific files — ZERO overlap between agents
3. Define all interfaces and data contracts between components
4. Write the plan to tasks/engineer-plan.md
5. Only spawn after the plan is written and interfaces are clear

═══ STEP 2 — SPAWN REAL PARALLEL AGENTS ═══
Run each workstream as a real parallel claude -p process:

```powershell
$workstreams = @(
  @{ name="agent1"; task="[workstream 1 — files it owns and exact task]" },
  @{ name="agent2"; task="[workstream 2 — files it owns and exact task]" }
)

$jobs = @()
foreach ($ws in $workstreams) {
    $prompt = "SmartEntry Pro engineer. Your task: $($ws.task). Only touch your assigned files. Commit after each file. Write working code only."
    $jobs += Start-Job -Name $ws.name -ScriptBlock {
        param($p)
        Set-Location 'C:\Users\User\ai-trading-dashboard'
        & claude -p $p --dangerously-skip-permissions 2>&1
    } -ArgumentList $prompt
}

Write-Host "[$($jobs.Count) agents running in parallel]"
$jobs | Wait-Job | Out-Null
$jobs | ForEach-Object { Receive-Job $_; Remove-Job $_ }
Write-Host "[All agents complete]"
```

Wall time = slowest agent, not sum of all.

═══ STEP 3 — VERIFY ═══
1. git log --oneline -15 — see what each agent committed
2. git status — check for conflicts
3. node --check on every .js file touched
4. python -m py_compile on every .py file touched

═══ STEP 4 — INTEGRATE & SHIP ═══
1. Wire components together where needed
2. Test key endpoints: curl http://localhost:3001/api/signals
3. Final commit: "engineer: [what was built]"

═══ RULES ═══
- Architect first — never spawn without a written plan in tasks/engineer-plan.md
- Each agent owns specific files with zero overlap
- You are integrator only — agents build, you connect
- If an agent fails, rebuild that piece yourself directly
- Max 6 agents — more causes file conflicts
- Simple tasks (1 file, 1 component) → do it directly, skip spawning
