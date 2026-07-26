@echo off
if not exist C:\ai-trading-dashboard-backups mkdir C:\ai-trading-dashboard-backups

for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set "dt=%%a"
set STAMP=%dt:~0,8%_%dt:~8,6%

powershell -Command ^
  "$candidates = 'C:\ai-trading-dashboard\server\journal.json','C:\ai-trading-dashboard\server\learning.json','C:\ai-trading-dashboard\server\smartentry.db','C:\ai-trading-dashboard\tasks\logs';" ^
  "$existing = $candidates | Where-Object { Test-Path $_ };" ^
  "if ($existing.Count -gt 0) { Compress-Archive -Path $existing -DestinationPath 'C:\ai-trading-dashboard-backups\backup_%STAMP%.zip' -Force }" ^
  2>>C:\ai-trading-dashboard\tasks\logs\backup_errors.txt

if exist "C:\ai-trading-dashboard-backups\backup_%STAMP%.zip" (
  echo [%date% %time%] Backup created: backup_%STAMP%.zip >> C:\ai-trading-dashboard\tasks\logs\backup_log.txt
) else (
  echo [%date% %time%] Backup FAILED - see backup_errors.txt >> C:\ai-trading-dashboard\tasks\logs\backup_log.txt
)

REM Keep only the most recent 14 backups
powershell -Command "Get-ChildItem 'C:\ai-trading-dashboard-backups\*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Force" 2>>C:\ai-trading-dashboard\tasks\logs\backup_errors.txt
