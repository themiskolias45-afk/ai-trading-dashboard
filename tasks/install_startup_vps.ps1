# Install VPS auto-start as a Windows Scheduled Task (AT LOGON).
# Run as Administrator on the VPS. Registers a single "SmartEntryAutoStart" task
# that calls startup_vps.ps1 at every login.

$proj    = 'C:\ai-trading-dashboard'
$script  = "$proj\tasks\startup_vps.ps1"
$taskName = 'SmartEntryAutoStart'

if (-not (Test-Path $script)) {
    Write-Host "ERROR: $script not found. Git pull first." -ForegroundColor Red
    exit 1
}

# Remove old version
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
    -WorkingDirectory $proj

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -RunLevel Highest `
        -Force | Out-Null

    Write-Host ""
    Write-Host "=== VPS Auto-Start INSTALLED ===" -ForegroundColor Green
    Write-Host "Task:  $taskName" -ForegroundColor Green
    Write-Host "Runs:  at every Windows login" -ForegroundColor Green
    Write-Host "Admin: YES (RunLevel Highest)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Run NOW (without restarting):"
    Write-Host "  Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Yellow
    Write-Host "Check logs:"
    Write-Host "  $proj\tasks\logs\startup_vps_*.txt" -ForegroundColor Yellow
} catch {
    # Fallback: Startup folder (works without admin)
    Write-Host "Task Scheduler failed: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "Falling back to Startup folder..." -ForegroundColor Yellow

    $startupDir = [System.Environment]::GetFolderPath('Startup')
    $shortcut = "$startupDir\SmartEntryProVPS.bat"
    "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" | Set-Content $shortcut -Encoding ASCII

    if (Test-Path $shortcut) {
        Write-Host "Installed to Startup folder: $shortcut" -ForegroundColor Green
    } else {
        Write-Host "FAILED. Install manually: add startup_vps.ps1 to Task Scheduler" -ForegroundColor Red
    }
}
