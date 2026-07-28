# Install SmartEntry Pro to auto-start at Windows login.
# Uses the user's Startup folder — no admin rights needed.
# Run once from PowerShell with Bypass: powershell -ExecutionPolicy Bypass -File tasks\install_startup.ps1

$proj      = 'C:\Users\User\ai-trading-dashboard'
$script    = "$proj\tasks\startup_all.ps1"
$startupDir = [System.Environment]::GetFolderPath('Startup')
$shortcut  = "$startupDir\SmartEntryPro.bat"

# Write a .bat launcher that calls the PowerShell script with Bypass
$bat = @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$script"
"@
Set-Content -Path $shortcut -Value $bat -Encoding ASCII

if (Test-Path $shortcut) {
    Write-Host ""
    Write-Host "=== SmartEntry Pro Auto-Start INSTALLED ===" -ForegroundColor Green
    Write-Host "Location: $shortcut" -ForegroundColor Green
    Write-Host "Runs:     at every Windows login (no admin needed)" -ForegroundColor Green
    Write-Host ""
    Write-Host "To run NOW without restarting:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$script`"" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To uninstall: delete $shortcut"
} else {
    Write-Host "FAILED to create shortcut in Startup folder." -ForegroundColor Red
    Write-Host "Startup folder path: $startupDir" -ForegroundColor Red
}
