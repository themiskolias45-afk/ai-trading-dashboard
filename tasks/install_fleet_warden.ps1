# Register "SmartEntry Fleet Warden" - run the parity check daily instead of never.
#
#   powershell -File tasks\install_fleet_warden.ps1
#
# ASCII ONLY - PS 5.1 reads a BOM-less .ps1 as ANSI.
#
# LAPTOP ONLY, deliberately. The warden compares this box against the peer, and the
# laptop cannot be reached from outside, so the VPS has no peer to check. tasks\
# fleet_warden.ps1 therefore stays off the VPS on purpose - the same reasoning as
# deploy_vps_catchup.ps1, which also runs FROM here TO there.
#
# 08:15 is chosen to land AFTER the daily check (07:30) has finished any deploying, so
# the warden reports the settled state rather than a half-finished one. It is not at
# 07:00 or 07:15 because the morning agent and the coverage audit already hold those.

$ErrorActionPreference = 'Stop'

$name   = 'SmartEntry Fleet Warden'
$script = Join-Path $PSScriptRoot 'fleet_warden.ps1'

if (-not (Test-Path $script)) {
    Write-Host "REFUSED: $script not found" -ForegroundColor Red
    exit 1
}

# Refuse to schedule a script that cannot parse. A task that fails on its first run at
# 08:15 tomorrow, unattended, is far more expensive to diagnose than one refused now.
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
    Write-Host "REFUSED: $script has parse errors:" -ForegroundColor Red
    $parseErrors | ForEach-Object { Write-Host ("  line " + $_.Extent.StartLineNumber + ": " + $_.Message) }
    exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"')

# Daily at 08:15. StartWhenAvailable below covers the laptop being asleep at the time -
# this box hibernates unattended for most of the day, so a trigger with no catch-up
# would simply never fire. That is the failure mode the whole autostart runbook exists
# for, and a new daily job must not walk into it.
$trigger = New-ScheduledTaskTrigger -Daily -At '08:15'

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

$task = Get-ScheduledTask -TaskName $name
$info = $task | Get-ScheduledTaskInfo
Write-Host ("REGISTERED: " + $task.TaskName + "  state=" + $task.State + "  next=" + $info.NextRunTime) -ForegroundColor Green
Write-Host "It is READ-ONLY: vps_parity.cjs hashes and compares, and cannot write to either box."
Write-Host "Exit 2 only on ENGINE drift. File-presence drift is reported, never failed, because"
Write-Host "some absences are deliberate - bridge_tags.ps1 must stay laptop-only."
