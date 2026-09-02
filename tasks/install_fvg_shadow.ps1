# Registers the FVG continuation shadow runner as a scheduled task.
#
# WHY --once ON A SCHEDULE rather than the runner's own setInterval loop: a long-lived
# node process dies with the shell that started it, leaves an orphan when it does not,
# and does not come back after a reboot. A 15-minute task has none of those properties
# and matches the execution timeframe -- checking more often cannot find a setup that
# needs a closed m15 bar to exist.
#
# SHADOW ONLY. The runner places no orders, touches no gate, threshold, position, setting
# or learning file, and writes exactly one append-only file: tasks/fvg_shadow.jsonl.
# Registering this cannot change what trades.
#
#   powershell -ExecutionPolicy Bypass -File tasks\install_fvg_shadow.ps1
#   powershell -ExecutionPolicy Bypass -File tasks\install_fvg_shadow.ps1 -Remove
#
# Runs at Limited level as the current user -- it needs no elevation, and asking for it
# would be a reason for someone to skip installing it.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'SmartEntry FVG Shadow'
$root     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $root 'tasks\fvg_runner.cjs'
$logFile  = Join-Path $root 'tasks\logs\fvg_shadow.txt'

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        "Removed scheduled task '$TaskName'."
    } else {
        "No task named '$TaskName' — nothing to remove."
    }
    return
}

if (-not (Test-Path $script)) { throw "Runner not found at $script" }

# Resolve node by RUNNING it, never by trusting PATH: a task that resolves to a different
# node than the shell does is the kind of difference nobody sees until it fails silently.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not on PATH — the task would be registered and never run." }
& $node --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "node at $node did not execute" }

$logDir = Split-Path -Parent $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# Output is appended, never overwritten: the shadow record is the whole point and a task
# that truncates its own log loses the evidence it exists to collect.
$cmd = "`"$node`" `"$script`" --once >> `"$logFile`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c $cmd" -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

$me = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'FVG continuation shadow runner — records setups only, places no orders.' | Out-Null

"Registered '$TaskName' — every 15 minutes, as $me."
"  runner : $script"
"  log    : $logFile"
"  verify : Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
