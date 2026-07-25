@echo off
title SmartEntry Pro — Install Auto-Startup
cd /d C:\Users\User\ai-trading-dashboard
echo.
echo  Installing SmartEntry Pro to start automatically at Windows login...
echo.

REM ── 1. Startup folder shortcut (no admin needed) ───────────────────────────
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set WRAPPER=%STARTUP%\SmartEntry.bat

(
  echo @echo off
  echo timeout /t 45 /nobreak ^>nul
  echo call "C:\Users\User\ai-trading-dashboard\START.bat"
) > "%WRAPPER%"

if errorlevel 1 (
  echo  ERROR: Could not write to Startup folder. Try running as Administrator.
  pause
  exit /b 1
)
echo  [1] Startup folder entry created.

REM ── 2. Task Scheduler (more reliable — requires Admin but silently skips if not) ──
schtasks /delete /tn "SmartEntryPro" /f >nul 2>&1
schtasks /create ^
  /tn "SmartEntryPro" ^
  /tr "cmd /c \"C:\Users\User\ai-trading-dashboard\START.bat\"" ^
  /sc ONLOGON ^
  /delay 0002:00 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f >nul 2>&1

if not errorlevel 1 (
  echo  [2] Task Scheduler entry created (runs 2 min after login^).
) else (
  echo  [2] Task Scheduler skipped (needs Admin^) — Startup folder will be used instead.
)

echo.
echo  DONE. SmartEntry Pro will launch automatically at every login.
echo.
echo  What starts automatically (45 seconds after login^):
echo   - Latest code pulled from GitHub
echo   - SmartEntry server on port 3001
echo   - Dashboard opens in browser
echo   - Watchdog (auto-restarts server if it crashes^)
echo   - MetaTrader 5
echo   - MT5 bridge in FULL-AUTO mode
echo.
echo  To disable: delete this file:
echo   %WRAPPER%
echo.
pause
