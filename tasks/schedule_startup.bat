@echo off
title SmartEntry Pro — Install Auto-Startup
cd /d C:\Users\User\ai-trading-dashboard
echo.
echo  Installing SmartEntry Pro to start automatically at Windows login...
echo.

REM ── Startup folder shortcut (runs at login, no admin needed) ───────────────
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set WRAPPER=%STARTUP%\SmartEntry.bat

(
  echo @echo off
  echo REM Wait 45 seconds for Windows and network to fully load
  echo timeout /t 45 /nobreak ^>nul
  echo call "C:\Users\User\ai-trading-dashboard\START.bat"
) > "%WRAPPER%"

if errorlevel 1 (
  echo  ERROR: Could not write to Startup folder.
  echo  Try running this script as Administrator.
  pause
  exit /b 1
)

REM ── Task Scheduler entry (backup — runs 2 min after login, requires admin) ─
schtasks /delete /tn "SmartEntry Startup" /f >nul 2>&1
schtasks /create ^
  /tn "SmartEntry Startup" ^
  /tr "\"C:\Users\User\ai-trading-dashboard\START.bat\"" ^
  /sc ONLOGON ^
  /delay 0002:00 ^
  /ru "%USERNAME%" ^
  /f >nul 2>&1

echo  DONE. SmartEntry Pro will launch automatically at every login.
echo.
echo  What happens when you open your laptop:
echo   [45s delay] Windows and network fully load
echo   [Step 0]    Kills any leftover old processes
echo   [Step 1]    Pulls latest code from GitHub
echo   [Step 2]    Starts SmartEntry server on port 3001
echo   [Step 3]    Opens dashboard in your browser automatically
echo   [Step 4]    Starts watchdog (auto-restarts server if it crashes)
echo   [Step 5]    Launches MetaTrader 5
echo   [Step 6]    Starts MT5 bridge in FULL-AUTO mode
echo.
echo  To disable auto-start: delete the file at:
echo   %WRAPPER%
echo.
pause
