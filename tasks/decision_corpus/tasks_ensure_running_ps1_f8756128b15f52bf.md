---
decision_key: f8756128b15f52bf
source: tasks/ensure_running.ps1:1
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

WHY IT NEVER KILLS

Governs: `$ErrorActionPreference = 'Stop'`

## The reasoning as recorded

SmartEntry Pro -- gap filler.

Starts ONLY what is missing and never kills anything. Safe to run on a schedule,
on unlock, at logon, and by hand, in any order and any number of times.

WHY THIS EXISTS
Everything that started SmartEntry automatically fired on LOGON: the Startup
folder shortcuts and the SmartEntryPro scheduled task. Opening a laptop lid is a
resume and an unlock, not a logon -- no trigger fires and the Startup folder is not
re-read. On 2026-08-02 the machine had been up for 18 days, so nothing had
auto-started since 15 July and the stack was only ever running because somebody
launched it by hand. The companion scheduled task (tasks\install_autostart.ps1)
fires this on unlock and every few minutes; this script is what makes that safe to
repeat.

WHY IT NEVER KILLS
START.bat is a cold-start script: it kills its own previous processes, then starts
a full stack, opens a browser and a claude window. Correct at logon, wrong every
ten minutes. This one only fills gaps, so a running system is left completely
alone and a half-dead one is repaired without disturbing the healthy half.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
