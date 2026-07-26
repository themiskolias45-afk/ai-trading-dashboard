# Registers the VPS self-reporting Scheduled Tasks. Run once, on the VPS.
#
# Both run as SYSTEM, not as the logged-on user, and the boot alert triggers at
# startup rather than at logon. That is deliberate: every other task on this box
# uses an onlogon trigger, so if Windows auto-logon ever fails, none of them run -
# and that is precisely the situation you need to be told about. A SYSTEM task at
# startup still fires, sees the other tasks did not start, and reports it.

$ErrorActionPreference = 'Stop'

$script    = 'C:\ai-trading-dashboard\tasks\vps_notify.ps1'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
                -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1)

$bootAction  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" -Mode boot')
Register-ScheduledTask -TaskName 'SmartEntryBootAlert' `
    -Action $bootAction -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Settings $settings -Principal $principal `
    -Description 'Telegram alert on every VPS startup. Runs as SYSTEM at boot so it fires even if auto-logon fails.' `
    -Force | Out-Null
Write-Output 'registered SmartEntryBootAlert'

$hbAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" -Mode heartbeat')
Register-ScheduledTask -TaskName 'SmartEntryHeartbeat' `
    -Action $hbAction -Trigger (New-ScheduledTaskTrigger -Daily -At '08:00') `
    -Settings $settings -Principal $principal `
    -Description 'Daily proof-of-life Telegram. The ABSENCE of this message is the alarm.' `
    -Force | Out-Null
Write-Output 'registered SmartEntryHeartbeat'
