---
decision_key: 949d985ff6474dc3
source: tasks/notify.ps1:36
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

Can this box raise an alarm? Returns $true/$false and NEVER the credentials.

Governs: `function Test-NotifierConfigured {`

## The reasoning as recorded

Can this box raise an alarm? Returns $true/$false and NEVER the credentials.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
