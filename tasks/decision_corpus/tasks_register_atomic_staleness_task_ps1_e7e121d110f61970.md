---
decision_key: e7e121d110f61970
source: tasks/register_atomic_staleness_task.ps1:37
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

DERIVED, NEVER HARDCODED. The laptop is C:\Users\User\ai-trading-dashboard under "User";

Governs: `$repo = Split-Path -Parent $PSScriptRoot`

## The reasoning as recorded

DERIVED, NEVER HARDCODED. The laptop is C:\Users\User\ai-trading-dashboard under "User";
the VPS is C:\ai-trading-dashboard under "administrator". A pinned path is the defect
that made mt5_ensure_running.ps1 write nowhere for three hours while logging success.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
