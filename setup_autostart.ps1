# SmartEntry Pro — Windows Auto-Start Setup
# Run this once in PowerShell as Administrator:
#   Right-click PowerShell → "Run as administrator"
#   cd C:\path\to\ai-trading-dashboard
#   .\setup_autostart.ps1

param(
    [string]$InstallPath = $PSScriptRoot,
    [string]$TaskName    = "SmartEntry"
)

$serverPath = Join-Path $InstallPath "server"
$logFile    = Join-Path $InstallPath "server.log"
$nodePath   = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $nodePath) {
    Write-Host "ERROR: Node.js not found. Install it from https://nodejs.org" -ForegroundColor Red
    exit 1
}

Write-Host "Setting up SmartEntry auto-start Task Scheduler entry..." -ForegroundColor Cyan
Write-Host "Install path: $InstallPath"
Write-Host "Node.js: $nodePath"
Write-Host "Log file: $logFile"

# Remove existing task if present
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Build the action: run node index.js from the server folder
$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c cd /d `"$serverPath`" && node index.js >> `"$logFile`" 2>&1" `
    -WorkingDirectory $serverPath

# Trigger: start at logon (starts when you log into Windows)
$trigger = New-ScheduledTaskTrigger -AtLogon

# Settings: restart on failure, run whether user is logged on or not
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 2) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -MultipleInstances IgnoreNew

# Register the task (runs as current user, highest privileges)
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -RunLevel    Highest `
    -Force | Out-Null

Write-Host ""
Write-Host "Done! SmartEntry will now start automatically when Windows boots." -ForegroundColor Green
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Yellow
Write-Host "  Start now:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Stop:        Stop-ScheduledTask  -TaskName '$TaskName'"
Write-Host "  Status:      Get-ScheduledTask   -TaskName '$TaskName' | Select-Object -ExpandProperty State"
Write-Host "  Remove:      Unregister-ScheduledTask -TaskName '$TaskName'"
Write-Host "  View log:    Get-Content '$logFile' -Tail 50"
Write-Host ""

# Optionally start it right now
$startNow = Read-Host "Start SmartEntry right now? [y/N]"
if ($startNow -match "^[Yy]") {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $state = (Get-ScheduledTask -TaskName $TaskName).State
    Write-Host "Task state: $state" -ForegroundColor Cyan
    Write-Host "Dashboard: http://localhost:3001" -ForegroundColor Green
}
