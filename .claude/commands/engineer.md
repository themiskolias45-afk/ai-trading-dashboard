Spawn parallel AI engineers to build complex systems simultaneously. Usage: /engineer [task]

$ARGUMENTS is the task to build. JARVIS breaks it into parallel workstreams and executes all at once.

How it works:
1. Analyse the task — what are the independent components?
2. Assign each component to a parallel engineer (sub-agent via `claude -p`)
3. All engineers run simultaneously — wall clock time = slowest, not sum
4. JARVIS collects all outputs and integrates them into the final system
5. Commit everything in one clean push

Parallel execution on Windows (run via Bash):
```powershell
$j1 = Start-Job { cd C:\Users\User\ai-trading-dashboard; claude -p "TASK1" --dangerously-skip-permissions }
$j2 = Start-Job { cd C:\Users\User\ai-trading-dashboard; claude -p "TASK2" --dangerously-skip-permissions }
$j3 = Start-Job { cd C:\Users\User\ai-trading-dashboard; claude -p "TASK3" --dangerously-skip-permissions }
$j1,$j2,$j3 | Wait-Job | Receive-Job
```

Rules for parallel engineers:
- Each engineer gets its own file domain (no two engineers touch the same file)
- Each engineer's task is fully self-contained and testable
- JARVIS is the architect — it designs the interface between components before spawning
- JARVIS is the integrator — after engineers finish, JARVIS wires everything together

Use this for:
- Building entire new features (UI + API + Python + tests in parallel)
- Refactoring large systems (each module in parallel)
- Research + implementation simultaneously (one researcher, one builder)
- Multi-symbol analysis (BTC analyst, GOLD analyst, SPX analyst all at once)
- Any task that has ≥2 independent components

Example: /engineer build a complete alert system with webhook receiver, signal filter, MT5 execution, and Telegram notification
→ JARVIS spawns 4 engineers simultaneously, integrates the outputs, ships it.
