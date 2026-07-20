@echo off
title Schedule Auto-Startup at Login
echo.
echo  Setting up SmartEntry to start automatically at Windows login...
echo.

REM Write a wrapper to the Startup folder that always calls the latest startup.bat
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set WRAPPER=%STARTUP%\SmartEntry.bat

(
  echo @echo off
  echo call "C:\Users\User\ai-trading-dashboard\tasks\startup.bat"
) > "%WRAPPER%"

if errorlevel 1 (
  echo  ERROR: Could not write to Startup folder.
  pause
  exit /b 1
)

REM Also try Task Scheduler for the delay feature (requires Admin — silent fail ok)
schtasks /delete /tn "SmartEntry Startup" /f >nul 2>&1
schtasks /create /tn "SmartEntry Startup" /tr "C:\Users\User\ai-trading-dashboard\tasks\startup.bat" /sc ONLOGON /delay 0002:00 /ru "%USERNAME%" /f >nul 2>&1

echo  SUCCESS. SmartEntry Pro will start automatically at every login.
echo.
echo  What starts automatically:
echo   - SmartEntry server (port 3001)
echo   - MT5 auto-launched (tries common install paths)
echo   - MT5 bridge in AUTO mode (after MT5 connects)
echo   - Data backup (journal + learning)
echo   - Morning agent already runs at 7 AM (already scheduled)
echo.
echo  If MT5 path is wrong: edit tasks\startup.bat and re-run this script.
echo  To disable: delete %WRAPPER%
echo.
pause
