# Register the task that keeps the TradingView browser alive in the INTERACTIVE session.
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY A TASK AND NOT JUST RUNNING THE .BAT
# Measured on the Contabo VPS 2026-09-05: launching Edge over SSH creates the profile
# directory, opens port 9222 for a moment, and then the process EXITS. A browser needs a
# window station and an SSH session does not have one. The port briefly listening is what
# makes this deceptive - the launcher reported success and CDP was dead seconds later.
#
# This is the same failure as trying to start MT5 over SSH earlier the same day: the
# process lands in the wrong Windows session and dies quietly. Every task on that box that
# actually works runs as Administrator with LogonType Interactive, so this one does too.
#
# WHAT IT DOES NOT DO: it does not trade, touch a signal, or read a gate. It starts a
# browser. tasks\tv_daily_plan.ps1 is the job that draws, and it refuses to draw when the
# server is not answering.
#
#   powershell -File tasks\install_tv_browser_task.ps1 [-WhatIf] [-Remove]

param([switch]$WhatIf, [switch]$Remove)

$ErrorActionPreference = 'Stop'

$taskName = 'SmartEntry TV Browser'
$proj     = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $proj 'tasks\launch_chrome_tv.bat'

if (-not (Test-Path $launcher)) { throw "launcher not found: $launcher" }

if ($Remove) {
    # Present so the change is reversible in one command, which is the standing rule.
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        if ($WhatIf) { Write-Output "  -WhatIf: would UNREGISTER '$taskName'"; exit 0 }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Output "  unregistered '$taskName' (the launcher and profile are untouched)"
    } else {
        Write-Output "  '$taskName' is not registered - nothing to remove"
    }
    exit 0
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "  '$taskName' already exists - leaving it alone."
    Write-Output "  Re-register by running with -Remove first, so nothing is silently replaced."
    exit 0
}

# Administrator + Interactive is not a preference, it is the requirement: a browser needs a
# desktop. Every working task on this box uses this principal; the two that use SYSTEM in
# session 0 are the two that were failing with 0xC0000142.
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$launcher`"" -WorkingDirectory $proj
$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Limited

# AtLogOn brings it back after a reboot. The repeating trigger is the actual guarantee:
# the launcher is a no-op when 9222 already answers, so re-running it costs nothing and
# it becomes self-healing if Edge is ever closed or crashes.
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(7) `
             -RepetitionInterval (New-TimeSpan -Minutes 30)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -MultipleInstances IgnoreNew `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

if ($WhatIf) {
    Write-Output "  -WhatIf: would register '$taskName'"
    Write-Output "    run     : cmd.exe /c `"$launcher`""
    Write-Output "    as      : Administrator (Interactive) - a browser needs a desktop"
    Write-Output "    when    : at logon, and every 30 minutes (no-op when 9222 is already up)"
    exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
    -Trigger @($atLogon, $repeat) -Settings $settings -ErrorAction Stop | Out-Null

# READ IT BACK. Register-ScheduledTask can report success for a task that did not land,
# which is how an installer exits 0 having installed nothing.
$check = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $check) { throw "registration reported success but '$taskName' is not present" }
Write-Output "  registered '$taskName'  state=$($check.State)  as=$($check.Principal.UserId)/$($check.Principal.LogonType)"
Write-Output "  remove it with: powershell -File tasks\install_tv_browser_task.ps1 -Remove"
