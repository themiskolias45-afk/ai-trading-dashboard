# Install SmartEntry Pro to auto-start at Windows login.
# Run this ONCE as Administrator. Creates a Scheduled Task that fires
# at logon and runs startup_all.ps1 automatically.

$proj    = 'C:\Users\User\ai-trading-dashboard'
$script  = "$proj\tasks\startup_all.ps1"
$taskName = 'SmartEntryPro-AutoStart'

# Remove old task if it exists
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action  = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -File `"$script`"" `
    -WorkingDirectory $proj

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Force

Write-Host ""
Write-Host "=== SmartEntry Pro Auto-Start INSTALLED ===" -ForegroundColor Green
Write-Host "Task: $taskName" -ForegroundColor Green
Write-Host "Runs: at every Windows login" -ForegroundColor Green
Write-Host "Script: $script" -ForegroundColor Green
Write-Host ""
Write-Host "To run NOW without restarting: " -NoNewline
Write-Host "Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Yellow
Write-Host "To check logs: " -NoNewline
Write-Host "$proj\tasks\logs\startup_all_*.txt" -ForegroundColor Yellow
