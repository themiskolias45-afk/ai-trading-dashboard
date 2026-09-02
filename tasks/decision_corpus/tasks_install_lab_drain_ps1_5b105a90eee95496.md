---
decision_key: 5b105a90eee95496
source: tasks/install_lab_drain.ps1:1
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

2. IT NEVER DELETES A TASK. install_autostart.ps1 calls

Governs: `param(`

## The reasoning as recorded

============================================================================
 install_lab_drain.ps1 - register the Strategy Lab drain
============================================================================

 Registers "SmartEntry Lab Drain", which runs tasks\lab_drain.ps1 on a repeat
 so queued backtests execute out of band. The server never runs one; this does.

 THREE DELIBERATE DIFFERENCES FROM install_autostart.ps1, all for safety:

  1. DRY RUN BY DEFAULT. It prints exactly what it would register and changes
     nothing until you pass -Execute. Same convention as
     tasks\safe_server_restart.ps1, and for the same reason: a script that acts
     the moment you run it gets run by accident exactly once.

  2. IT NEVER DELETES A TASK. install_autostart.ps1 calls
     Unregister-ScheduledTask to replace an existing one. This refuses instead,
     and says so. With -Force it will replace - but only after EXPORTING the
     existing definition to tasks\logs\<name>.<timestamp>.xml first, so the
     thing it is about to overwrite still exists on disk afterwards. Nothing in
     this project is destroyed to make room for something else.

  3. IT ASSUMES NOTHING ABOUT ELEVATION. The task runs as the current user, at
     Limited level, exactly like the drain does by hand. Reading CSVs and
     writing JSON needs no more than that, and asking for more would be asking
     for trouble.

 WHAT THE TASK WILL DO, stated plainly: every $IntervalMinutes it runs
 lab_drain.ps1, which executes at most -Max queued candidates against
 historical CSV files and writes assessment artifacts. It does not contact the
 broker, does not read or write any live config, and cannot change what trades.

 USAGE
   powershell -NoProfile -ExecutionPolicy Bypass -File tasks\install_lab_drain.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File tasks\install_lab_drain.ps1 -Execute
   powershell -NoProfile -ExecutionPolicy Bypass -File tasks\install_lab_drain.ps1 -Execute -Force
============================================================================

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
