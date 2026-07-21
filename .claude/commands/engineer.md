Spawn parallel AI engineers to build complex systems simultaneously. Usage: /engineer [task]

$ARGUMENTS is the task. JARVIS plans the workstreams and runs all engineers in parallel.

Steps:
1. Run the planner to break the task into independent parallel workstreams:
   python parallel_agents.py --plan "$ARGUMENTS"

2. All engineers run simultaneously. Wall time = slowest, not sum.

3. Read all outputs and integrate into the final system.

4. Commit everything in one clean push.

Rules:
- Each engineer owns different files — no two engineers touch the same file
- Each engineer's task must be 100% self-contained (no shared state mid-run)
- JARVIS is architect + integrator — it designs the interfaces before spawning
- If the task is simple (1 component), just do it directly — don't over-engineer

When to use /engineer:
- Building a full feature (UI + API + Python + tests)
- Multi-symbol analysis (BTC + GOLD + SPX simultaneously)
- Research AND implementation at the same time
- Any task with 3+ independent components

The engine uses your existing Claude Pro session — no API key required.
Up to 8 engineers run in parallel. Each is a full JARVIS instance with all tools.
