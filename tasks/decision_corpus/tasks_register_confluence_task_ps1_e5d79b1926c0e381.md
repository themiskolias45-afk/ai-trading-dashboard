---
decision_key: e5d79b1926c0e381
source: tasks/register_confluence_task.ps1:36
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

DERIVED, NEVER HARDCODED. The first version of this file pinned the laptop's repo root

Governs: `$repo = Split-Path -Parent $PSScriptRoot`

## The reasoning as recorded

DERIVED, NEVER HARDCODED. The first version of this file pinned the laptop's repo root
and its "User" account. On the VPS — which lives at C:\ai-trading-dashboard under
"administrator" — it reported MISSING instead of registering. That is the same defect as
mt5_ensure_running.ps1 hardcoding the VPS repo root twice, and the only reason it was
caught here instead of shipped is that this script checks its paths before registering.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
