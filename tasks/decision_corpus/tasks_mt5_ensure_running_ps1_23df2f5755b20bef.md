---
decision_key: 23df2f5755b20bef
source: tasks/mt5_ensure_running.ps1:1
status: standing
recorded: 2026-09-05T06:30:27.886Z
---

# STANDING DECISION

IT NEVER KILLS. It starts MT5 only when no terminal64 process exists. There is no stop,

Governs: `$ErrorActionPreference = 'SilentlyContinue'`

## The reasoning as recorded

Keeps MT5 running on the VPS, and publishes what it can see so you can LOOK at it.

WHY. Checked 2026-09-04: nothing on this box restarts MT5. No scheduled task, no Run key,
an empty Startup folder. The terminal had been up 29 days and the VPS 40, so it had never
bitten - but one Windows Update reboot would take the terminal down and, with it, the
chart EA and the bridge's MT5 connection, silently, until a human noticed. That is the
opposite of 24/7.

IT NEVER KILLS. It starts MT5 only when no terminal64 process exists. There is no stop,
no restart and no /kill path anywhere in this file: a terminal that is up is left exactly
alone, mid-trade or not. Modelled on tasks\ensure_running.ps1, which fills gaps and never
kills, and is therefore safe to run on any schedule.

AutoAdminLogon is 1 on this box with an active console session, so after a reboot there
is a real desktop for MT5 to start into. That matters: MT5 is a GUI application and a
terminal started without a session cannot render charts or run a chart EA properly.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
