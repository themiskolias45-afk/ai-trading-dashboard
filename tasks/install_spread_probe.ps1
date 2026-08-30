# Registers "SmartEntry Spread Probe" to sample broker spreads every 5 minutes
# across the Monday session, then stop on its own.
#
# Self-terminating BY DESIGN. A probe that answers one question and then keeps
# running forever becomes another scheduled job nobody remembers owning -- the
# repetition carries a 24h duration and the task carries an end boundary, so it
# expires without anyone having to remember to remove it.
#
#   powershell -ExecutionPolicy Bypass -File tasks\install_spread_probe.ps1
#   powershell -ExecutionPolicy Bypass -File tasks\install_spread_probe.ps1 -Remove
#
# CAVEAT THIS CANNOT FIX: the probe needs the MT5 terminal running, which needs this
# machine awake. Laptop sleep is accepted on this box, so a slept-through Monday
# yields no samples. The VPS is the reliable host for this; see the report.

# -RunAsSystem is for the VPS. That box is HEADLESS: a task registered with the
# default interactive principal fails with 0x800710E0 (ERROR_NO_INTERACTIVE_SESSION)
# and the only sign is a task that reports success while never having run. SYSTEM is
# demonstrably able to launch processes there -- SmartEntryEnsureRunning does it every
# 10 minutes. Whether SYSTEM can reach the MT5 terminal's IPC is a separate question
# this script cannot answer by reasoning, so ALWAYS run the task once after
# registering and read the probe log rather than the task's exit code.
param([switch]$Remove, [string]$PythonExe, [switch]$RunAsSystem)

$ErrorActionPreference = "Stop"

$TaskName = "SmartEntry Spread Probe"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProbeScript = Join-Path $ProjectRoot "tasks\spread_probe.py"

# The two boxes have different interpreters (laptop 3.12 under AppData, VPS 3.11 under
# Program Files), so this is DISCOVERED, not hardcoded. A hardcoded path that happens
# to be right on one machine is how a deploy silently registers a task that can never
# run on the other.
if (-not $PythonExe) {
    $candidates = @(
        "C:\Users\User\AppData\Local\Programs\Python\Python312\python.exe",
        "C:\Program Files\Python311\python.exe",
        "C:\Program Files\Python312\python.exe"
    )
    $PythonExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $PythonExe) {
        $found = (Get-Command python -ErrorAction SilentlyContinue).Source
        if ($found) { $PythonExe = $found }
    }
}

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "removed '$TaskName'"
    } else {
        Write-Output "'$TaskName' was not registered; nothing to remove"
    }
    exit 0
}

if (-not (Test-Path $ProbeScript)) { throw "probe script not found: $ProbeScript" }
if (-not (Test-Path $PythonExe))   { throw "python not found: $PythonExe" }

# Start at the Sunday-night index open so the first hours of the week are captured,
# and run for 24h to cover the US cash session, which is when spreads are tightest
# and therefore when a fair comparison against SP500 can be made.
$start = Get-Date "2026-08-30 23:00:00"
if ($start -lt (Get-Date)) { $start = (Get-Date).AddMinutes(2) }

$action = New-ScheduledTaskAction -Execute $PythonExe `
    -Argument "`"$ProbeScript`"" -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Hours 24)

# Never wake the machine and never fight the user for resources: this is a
# measurement, not a trading component, and it must not be the reason the box is up.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
    -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

$description = "Samples NAS100/SP500 broker spreads every 5 min for one session, to settle the SP500->NAS100 swap on measured cost."

if ($RunAsSystem) {
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description $description | Out-Null
} else {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Description $description | Out-Null
}

$task = Get-ScheduledTask -TaskName $TaskName
Write-Output "registered '$TaskName'"
Write-Output "  starts    : $start"
Write-Output "  repeats   : every 5 min for 24h, then expires"
Write-Output "  state     : $($task.State)"
Write-Output "  read with : python tasks\spread_probe.py --report"
