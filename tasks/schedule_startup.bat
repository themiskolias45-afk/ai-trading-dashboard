@echo off
title Schedule Auto-Startup at Login
echo.
echo  Setting up SmartEntry to start automatically at Windows login...
echo.

REM Remove old tasks
schtasks /delete /tn "SmartEntry Startup" /f >nul 2>&1

REM Create startup task — runs 2 minutes after login (gives Windows time to settle)
schtasks /create /tn "SmartEntry Startup" /tr "C:\Users\User\ai-trading-dashboard\tasks\startup.bat" /sc ONLOGON /delay 0002:00 /ru "%USERNAME%" /f

if errorlevel 1 (
  echo  ERROR: Run this as Administrator.
  pause
  exit /b 1
)

echo  SUCCESS. SmartEntry Pro will start automatically 2 minutes after every login.
echo.
echo  What starts automatically:
echo   - SmartEntry server (port 3001)
echo   - Data backup (journal + learning)
echo   - MT5 bridge in AUTO mode (if MT5 is open)
echo   - Morning agent already runs at 7 AM (already scheduled)
echo.
echo  To stop auto-start:  schtasks /delete /tn "SmartEntry Startup" /f
echo  To run manually:     tasks\startup.bat
echo.
pause
