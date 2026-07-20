@echo off
title Schedule Auto-Startup at Login
echo.
echo  Setting up SmartEntry to start automatically at Windows login...
echo.

REM Method 1: Try Task Scheduler (needs Admin)
schtasks /delete /tn "SmartEntry Startup" /f >nul 2>&1
schtasks /create /tn "SmartEntry Startup" /tr "C:\Users\User\ai-trading-dashboard\tasks\startup.bat" /sc ONLOGON /delay 0002:00 /ru "%USERNAME%" /f >nul 2>&1

if not errorlevel 1 (
  echo  SUCCESS via Task Scheduler. SmartEntry starts 2 min after every login.
  goto :done
)

REM Method 2: No Admin needed — Windows Startup folder
echo  Task Scheduler needs Admin. Using Startup folder instead...
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP%\SmartEntry.bat

copy /Y "C:\Users\User\ai-trading-dashboard\tasks\startup.bat" "%SHORTCUT%" >nul

if errorlevel 1 (
  echo  ERROR: Both methods failed.
  pause
  exit /b 1
)

echo  SUCCESS via Startup folder.

:done
echo.
echo  SmartEntry Pro will start automatically at every login.
echo.
echo  What starts automatically:
echo   - SmartEntry server (port 3001)
echo   - Data backup (journal + learning)
echo   - MT5 bridge in AUTO mode (if MT5 is open)
echo   - Morning agent already runs at 7 AM (already scheduled)
echo.
echo  To disable: delete %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SmartEntry.bat
echo.
pause
