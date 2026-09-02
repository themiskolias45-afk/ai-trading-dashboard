---
decision_key: 9ce979d33b870d44
source: tasks/install_market_schedule.ps1:64
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

FULL PATH, NEVER THE BARE NAME. Measured 2026-09-02 on the VPS: a task

Governs: `$exe = Resolve-NodeExe`

## The reasoning as recorded

FULL PATH, NEVER THE BARE NAME. Measured 2026-09-02 on the VPS: a task
registered with -Execute 'node.exe' reported LastTaskResult 0 and did
nothing - the log it writes did not gain a single line. A task that
reports success while doing no work is the same shape as eb5d176's
"Graph OK" over an empty store, and LastTaskResult never reveals it.
Every node task that already works on the VPS carries a resolved path.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
