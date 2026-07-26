# Registers the JARVIS learning/improvement Scheduled Tasks on the VPS.
#
# These ran only on the local PC, which is off most of the time, so the daily
# improvement loop fired only when someone was at the keyboard. The VPS runs 24/7
# and is where the system actually lives. The reason they were never moved is that
# the claude CLI was not installed here — it is now (2.1.220, 2026-07-26).
#
# Run once, on the VPS.

$ErrorActionPreference = 'Stop'

$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\Administrator" `
                -LogonType Interactive -RunLevel Highest

# Generous time limit: these invoke the claude CLI, which can take minutes.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
                -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)

function Register-Learning($name, $bat, $trigger, $desc) {
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $bat + '"')
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
    Write-Output "registered $name"
}

Register-Learning 'SmartEntryMorningAgent' `
    'C:\ai-trading-dashboard\tasks\morning_agent_vps.bat' `
    (New-ScheduledTaskTrigger -Daily -At '07:00') `
    'JARVIS autonomous morning cycle - system check, signals, learning state'

Register-Learning 'SmartEntryDailyCheck' `
    'C:\ai-trading-dashboard\tasks\auto_daily_vps.bat' `
    (New-ScheduledTaskTrigger -Daily -At '07:30') `
    'Daily signal and risk check'

Register-Learning 'SmartEntryWeeklyReview' `
    'C:\ai-trading-dashboard\tasks\auto_weekly_vps.bat' `
    (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '10:00') `
    'Weekly performance review and improvement proposal'

Write-Output ''
Write-Output 'Learning tasks now on the VPS:'
schtasks /query /fo table /nh | Select-String 'SmartEntry' | ForEach-Object { '  ' + $_.Line.Trim() }
