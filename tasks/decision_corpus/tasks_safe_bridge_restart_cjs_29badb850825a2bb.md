---
decision_key: 29badb850825a2bb
source: tasks/safe_bridge_restart.cjs:372
status: standing
recorded: 2026-09-04T06:15:50.682Z
---

# STANDING DECISION

WAS NEVER STOPPED answers yes — so this tool could report a clean restart having

Governs: `const bridgePids = () => {`

## The reasoning as recorded

PIDs BEFORE. The reconnect check below asks "is a bridge reporting", and a bridge that
WAS NEVER STOPPED answers yes — so this tool could report a clean restart having
replaced nothing.

That is not hypothetical. On the VPS on 2026-09-03 it printed "reconnected after 10s",
"600-bar change is live" and "Done", while python PID 828 from 2026-09-01 01:59 was
still running the pre-patch code. The bridge log has no restart banner anywhere in the
window — one continuous run straight through. The deploy read as complete and the new
field simply never appeared, which is the most expensive shape of failure this repo
has: a green check over an unchanged system.

ROOT CAUSE, and it is not the one the comments above cover. Stop-ScheduledTask kills
only what the TASK owns. A bridge started any other way — by hand, or by
ensure_running.ps1's detached Start-Process — is not the task's child, so stopping the
task is a no-op against it and no error is raised. Ownership is the thing that has to
be checked, and it cannot be assumed from the task existing.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
