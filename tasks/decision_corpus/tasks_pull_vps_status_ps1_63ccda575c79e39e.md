---
decision_key: 63ccda575c79e39e
source: tasks/pull_vps_status.ps1:29
status: standing
recorded: 2026-09-08T03:37:10.852Z
---

# STANDING DECISION

later - but the script NEVER EXECUTES. No START line, no log entry, no file written, and

Governs: `$refresh = @'`

## The reasoning as recorded

REFRESH THE SOURCE BEFORE PULLING IT.

Measured 2026-09-06: the VPS task "MT5 Ensure Running" launches powershell.exe - Task
Scheduler's own Operational log records the launch and a successful completion one second
later - but the script NEVER EXECUTES. No START line, no log entry, no file written, and
LastTaskResult stays 0 with NumberOfMissedRuns 0. Verified it is not the script (the task's
exact command line runs correctly over SSH and writes), not the arguments (byte-checked,
pure ASCII, path resolves), not the file encoding (no BOM, zero non-ASCII), and not the
RunLevel (the CRT/TK/FVG shadow tasks are equally 'Limited' and write every few minutes).

The consequence was silent and user-visible: the status file aged past 30 minutes and the
AI Brain panel showed "Status UNKNOWN" while MT5, the EA and the trades were all perfectly
healthy. A stale file read as a sick system.

So this pull refreshes the source first rather than faithfully copying a frozen file. It is
a workaround, not a fix - the VPS task is still not running - but it is in a script that
demonstrably runs every 10 minutes, and it fails soft: if ssh is unavailable the pull still
copies whatever is there, exactly as before.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
