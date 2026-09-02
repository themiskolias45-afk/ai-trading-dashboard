---
decision_key: 6a3c6cee164ecf78
source: tasks/install_lab_drain.ps1:140
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

IgnoreNew: a slow drain must NEVER have a second copy started on top of it. Two

Governs: `$settings = New-ScheduledTaskSettingsSet ``

## The reasoning as recorded

IgnoreNew: a slow drain must NEVER have a second copy started on top of it. Two
drains would run the same queued job twice and register it as two distinct runs,
which would corrupt the trial count - the one number this whole lab rests on.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
