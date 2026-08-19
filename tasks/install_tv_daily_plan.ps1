# Register (or re-register) the TradingView daily-plan task.
#
#   powershell -File tasks\install_tv_daily_plan.ps1
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY THIS EXISTS RATHER THAN A ONE-LINER
# The task was first registered by hand. That leaves the schedule as knowledge in one
# person's head: re-create the box, or delete the task by accident, and the reasoning
# behind the two firing times is gone. This file IS the source of truth for them.
#
# ONLY THE LAPTOP. tradingview_bot.py attaches to a logged-in TradingView session in a
# dedicated Edge profile over CDP 9222. The VPS has no such session, so this must not be
# installed there - tv_daily_plan.ps1 would refuse on every run and the doctor would
# carry an item that box could never clear.

$ErrorActionPreference = 'Stop'

$proj   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $proj 'tasks\tv_daily_plan.ps1'
$name   = 'SmartEntry TV Daily Plan'
$me     = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $script)) { throw "Not found: $script" }

# TWO DRAWS A DAY, and the times are chosen against the market, not the clock.
#
# Gold trades around the clock, so a single afternoon draw left the London session on
# levels computed for the previous NEW YORK one.
#
#   06:45 local - before the London open. DELIBERATELY EARLY ENOUGH TO SURVIVE DST:
#                 the scheduler fires on LOCAL time while this system's sessions are
#                 UTC boundaries, so the same wall-clock trigger moves an hour against
#                 the market twice a year. 06:45 is 05:45Z under BST and 06:45Z under
#                 GMT - ahead of the 07:00Z PRE-LONDON boundary in both, and ahead of
#                 the 08:00 London cash open in both.
#   13:15 local - just after 'SmartEntry Pre-Open Plan' (13:00) rebuilds the document,
#                 so the charts and the plan carry the same numbers for NEW YORK.
$triggers = @(
    (New-ScheduledTaskTrigger -Daily -At '06:45'),
    (New-ScheduledTaskTrigger -Daily -At '13:15')
)

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
    -WorkingDirectory $proj

# StartWhenAvailable is load-bearing on this box, not a nicety: the laptop was offline
# for ~107 hours across one recent week, so a fixed time that is simply MISSED when the
# lid is shut would drop most draws. This fires the missed run on the next resume.
# IgnoreNew so a slow run never gets a second copy driving the same browser.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

# Interactive: the bot drives a real Edge window and must live in the desktop session.
# Limited matches the other working laptop tasks - and matters, because the artifacts it
# rewrites are owned by the same plain user that runs it. Running this as an elevated
# Administrator would reproduce the VPS's EPERM failure in reverse.
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Output "Replaced existing task: $name"
}

Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal `
    -Description ('Draws the live SmartEntry plan (entry/stop/target) on the TradingView ' +
                  'charts for BTC, GOLD and SPX. Twice daily: before the London open and ' +
                  'after the pre-open plan. Reads /api/signals live, refuses to draw if the ' +
                  'server is down, and launches its own Edge on CDP 9222 if needed.') | Out-Null

$task = Get-ScheduledTask -TaskName $name
$info = Get-ScheduledTaskInfo -TaskName $name
Write-Output "Registered: $name"
Write-Output ("  user={0} runlevel={1} state={2}" -f $task.Principal.UserId, $task.Principal.RunLevel, $task.State)
foreach ($t in $task.Triggers) { Write-Output ("  trigger: " + $t.StartBoundary) }
Write-Output ("  nextRun={0}" -f $info.NextRunTime)
Write-Output ("  startWhenAvailable={0}  battery-ok={1}" -f
    $task.Settings.StartWhenAvailable, (-not $task.Settings.DisallowStartIfOnBatteries))
