# Prints how many SmartEntry Watchdog processes are running.
#
# Companion to count_guardians.ps1, and written for the same reason it was: on
# 2026-08-08 the guardian's single-instance guard was found to count GUARDIANS only,
# so exactly one guardian supervised its own watchdog while a second, orphaned
# watchdog (PID 23920, parent already dead) ran beside it unnoticed from 06:00:24.
# The log double-heartbeated all morning and nothing treated that as a fault.
#
# Two watchdogs matter because the server-restart branch has no cooldown of its own:
# both see the server down, both taskkill it, both start node, and the loser takes
# EADDRINUSE. The bridge branches survive it only because a marker file happens to
# serialise them.
#
# LIKE '%watchdog.bat%' deliberately does NOT match watchdog_guardian.bat -- that
# string does not contain "watchdog.bat" as a substring. Underscore is a single-char
# wildcard in WQL, so a pattern written with one would silently match the guardian
# too and every guardian would think a watchdog already existed.
#
# Same rationale as count_guardians.ps1 for living in its own file: embedding a
# PowerShell pipeline in a batch `for /f` backtick block is fragile, and an escaping
# mistake makes the query return nothing, which reads as "no duplicates" and fails
# the guard open.
$query = "SELECT ProcessId FROM Win32_Process WHERE Name = 'cmd.exe' AND CommandLine LIKE '%watchdog.bat%'"
try {
    @(Get-CimInstance -Query $query -ErrorAction Stop).Count
} catch {
    # Fail SAFE, not open. Unreadable process list means we claim a watchdog already
    # exists so the guardian backs off rather than stacking a second one. A minute
    # without a watchdog is recoverable; two watchdogs racing a server restart is the
    # failure this file exists to prevent.
    Write-Output 99
}
