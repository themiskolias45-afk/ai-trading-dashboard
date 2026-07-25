@echo off
title SmartEntry Pro — Admin Auto-Start Setup
cd /d C:\Users\User\ai-trading-dashboard

echo.
echo  ==========================================
echo   SmartEntry Pro — FULL AUTO-START SETUP
echo  ==========================================
echo.

REM ── Check if running as Administrator ──────────────────────────────────────
net session >nul 2>&1
if errorlevel 1 (
  echo  NOT running as Administrator.
  echo  Right-click this file and choose "Run as administrator"
  echo.
  pause
  exit /b 1
)

echo  Running as Administrator. Installing...
echo.

REM ── Remove old entries ─────────────────────────────────────────────────────
schtasks /delete /tn "SmartEntryPro"    /f >nul 2>&1
schtasks /delete /tn "SmartEntry Startup" /f >nul 2>&1

REM ── Task Scheduler — triggers 90 seconds after login ──────────────────────
schtasks /create ^
  /tn "SmartEntryPro" ^
  /tr "cmd /c \"C:\Users\User\ai-trading-dashboard\START.bat\"" ^
  /sc ONLOGON ^
  /delay 0001:30 ^
  /ru "User" ^
  /rl HIGHEST ^
  /f

if errorlevel 1 (
  echo.
  echo  ERROR: Task Scheduler failed. Try again as Administrator.
  pause
  exit /b 1
)

REM ── Also keep Startup folder as backup ─────────────────────────────────────
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
(
  echo @echo off
  echo timeout /t 90 /nobreak ^>nul
  echo call "C:\Users\User\ai-trading-dashboard\START.bat"
) > "%STARTUP%\SmartEntry.bat"

echo.
echo  ==========================================
echo   AUTO-START INSTALLED SUCCESSFULLY
echo  ==========================================
echo.
echo   Task Scheduler: ON (90s after login, runs as User, high priority)
echo   Startup folder: ON (backup)
echo.
echo   Next login: wait 90 seconds - everything starts automatically.
echo   Server, dashboard, MT5, bridge - all running before you type anything.
echo.
pause
