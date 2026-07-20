@echo off
title Schedule Auto Backup
echo.
echo  Setting up automatic data backup every 6 hours...
echo.

schtasks /delete /tn "SmartEntry Data Backup" /f >nul 2>&1

schtasks /create /tn "SmartEntry Data Backup" /tr "C:\Users\User\ai-trading-dashboard\tasks\backup_data.bat" /sc HOURLY /mo 6 /ru "%USERNAME%" /f

if errorlevel 1 (
  echo  ERROR: Run as Administrator.
  pause
  exit /b 1
)

echo  SUCCESS. Journal and learning data backed up every 6 hours automatically.
echo  Backups saved to: tasks\backups\YYYYMMDD\
echo  Latest always at: tasks\backups\journal_latest.json
echo.
pause
