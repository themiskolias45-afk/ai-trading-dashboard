---
decision_key: 1744f601b67e1b5e
source: server/ai_work_ledger.js:627
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

Distinguish "this run was killed" from "this job has NEVER written a

Governs: `verdict = "NO COMPLETION MARKER";`

## The reasoning as recorded

Distinguish "this run was killed" from "this job has NEVER written a
marker". Until 2026-08-09 the bat files invoked claude (a .CMD) without
CALL, so control never returned and every line after it — including the
marker — was dead. Reporting those historical runs as INCOMPLETE would
blame the run for a script bug.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
