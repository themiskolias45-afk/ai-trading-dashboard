# Register the gate-crossing watcher on THIS box.
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY: notifications.py has had notify_signal() and a `signal` CLI since it was written
# and NOTHING HAS EVER CALLED THEM. The system computes a gate-clearing signal, writes it
# to /api/signals, and tells nobody. This is the caller.
#
# It READS ONLY. tasks\gate_watch.py fetches /api/signals and /api/strategy-settings and
# shells to notifications.py. It cannot place, size, modify or close a trade, and it
# cannot move a threshold. The worst it can do is send a message.
#
# EVERY 5 MINUTES, session 0 is fine. Unlike the browser jobs this needs no desktop, so it
# runs as SYSTEM - except on this fleet two SYSTEM tasks were dying at 0xC0000142 from
# session-0 process-creation contention, so the start minute is chosen to miss the known
# repeating cadences (:01/:16/:31/:46, :02/:17/:32/:47, :03/:13/:23/:33/:43/:53, :07).
#
#   powershell -File tasks\install_gate_watch_task.ps1 [-WhatIf] [-Remove]

param([switch]$WhatIf, [switch]$Remove)

$ErrorActionPreference = 'Stop'

$taskName = 'SmartEntry Gate Watch'
$proj     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $proj 'tasks\gate_watch.py'

if (-not (Test-Path $script)) { throw "not found: $script" }

if ($Remove) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        if ($WhatIf) { Write-Output "  -WhatIf: would UNREGISTER '$taskName'"; exit 0 }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Output "  unregistered '$taskName' (the script and its state are untouched)"
    } else { Write-Output "  '$taskName' is not registered" }
    exit 0
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Write-Output "  '$taskName' already exists - leaving it alone. Use -Remove to replace."
    exit 0
}

# Resolve python the same way the rest of the fleet does rather than assuming a path:
# a task that hardcodes an interpreter breaks silently the day it moves.
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw "python not found on PATH" }

$action    = New-ScheduledTaskAction -Execute $python -Argument "`"$script`"" -WorkingDirectory $proj
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddMinutes(9)) `
             -RepetitionInterval (New-TimeSpan -Minutes 5) `
             -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -MultipleInstances IgnoreNew `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
              -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 2)

if ($WhatIf) {
    Write-Output "  -WhatIf: would register '$taskName'"
    Write-Output "    run  : $python `"$script`""
    Write-Output "    as   : SYSTEM (no desktop needed - it only reads two endpoints)"
    Write-Output "    when : every 5 minutes, starting at :09 to miss the busy minutes"
    exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
    -Trigger $trigger -Settings $settings -ErrorAction Stop | Out-Null

# Read it back: Register-ScheduledTask can report success for a task that did not land.
$check = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $check) { throw "registration reported success but '$taskName' is not present" }
$info = $check | Get-ScheduledTaskInfo
Write-Output "  registered '$taskName'  state=$($check.State)  next=$($info.NextRunTime)"
Write-Output "  remove it with: powershell -File tasks\install_gate_watch_task.ps1 -Remove"
