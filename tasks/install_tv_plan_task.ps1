# Register the daily-plan drawing job on THIS box.
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY THIS EXISTS
# The laptop has 'SmartEntry TV Daily Plan' and the VPS had nothing - so the charts were
# only ever drawn while the laptop happened to be awake. The VPS is the box that runs
# continuously, so that is where this belongs.
#
# WHAT IT RUNS: tasks\tv_daily_plan.ps1, which REFUSES to draw when the SmartEntry server
# is not answering. Levels put on a live chart from a dead engine look current and are
# not, which is worse than no levels - the same reasoning as the bridge's STALE_SOURCE
# gate. It draws; it never trades.
#
# TIMES ARE UTC-DERIVED FROM THE LOCAL CLOCK ON PURPOSE. The two boxes are in different
# timezones (laptop +1, VPS +2), so "07:30 local" is a different instant on each. These
# are set from the local clock and the log records both, rather than assuming they agree.
#
#   powershell -File tasks\install_tv_plan_task.ps1 [-WhatIf] [-Remove]

param([switch]$WhatIf, [switch]$Remove)

$ErrorActionPreference = 'Stop'

$taskName = 'SmartEntry TV Daily Plan'
$proj     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $proj 'tasks\tv_daily_plan.ps1'

if (-not (Test-Path $script)) { throw "not found: $script" }

if ($Remove) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        if ($WhatIf) { Write-Output "  -WhatIf: would UNREGISTER '$taskName'"; exit 0 }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Output "  unregistered '$taskName' (the script itself is untouched)"
    } else {
        Write-Output "  '$taskName' is not registered"
    }
    exit 0
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Write-Output "  '$taskName' already exists - leaving it alone."
    Write-Output "  Run with -Remove first if you intend to replace it."
    exit 0
}

# INTERACTIVE, like the browser task. tv_daily_plan.ps1 drives a real browser through
# CDP, and a session-0 task has no desktop for one to live in - measured on this fleet:
# a browser launched without a window station opens its port for a moment and exits.
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
               -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" `
               -WorkingDirectory $proj
$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Limited

# Two runs: before the London open and before the New York open, matching the laptop's
# existing pair. StartWhenAvailable so a missed run is caught up rather than skipped.
$t1 = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(6).AddMinutes(45))
$t2 = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(13).AddMinutes(15))

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -MultipleInstances IgnoreNew `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
              -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)

if ($WhatIf) {
    Write-Output "  -WhatIf: would register '$taskName'"
    Write-Output "    run  : powershell -File `"$script`""
    Write-Output "    as   : Administrator (Interactive) - it drives a real browser"
    Write-Output "    when : 06:45 and 13:15 local, 2 retries 10 min apart"
    exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
    -Trigger @($t1, $t2) -Settings $settings -ErrorAction Stop | Out-Null

# Read it back: Register-ScheduledTask can report success for a task that did not land.
$check = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $check) { throw "registration reported success but '$taskName' is not present" }
$info = $check | Get-ScheduledTaskInfo
Write-Output "  registered '$taskName'  state=$($check.State)  next=$($info.NextRunTime)"
Write-Output "  remove it with: powershell -File tasks\install_tv_plan_task.ps1 -Remove"
