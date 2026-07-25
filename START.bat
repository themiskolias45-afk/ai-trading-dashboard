@echo off
title SmartEntry Pro — STARTING...
cd /d "%~dp0"
if not exist tasks\logs mkdir tasks\logs

echo.
echo  ==========================================
echo   SmartEntry Pro — AUTO LAUNCH
echo  ==========================================
echo.

REM ── Load API keys ──────────────────────────────────────────────
if exist keys.env (
  for /f "usebackq tokens=1,* delims==" %%a in ("keys.env") do set "%%a=%%b"
)
if exist server\apikey.txt (
  set /p ANTHROPIC_API_KEY=<server\apikey.txt
)

REM ── Kill anything already using port 3001 ──────────────────────
echo  [0] Clearing old processes...
taskkill /F /IM node.exe   /T >nul 2>&1
taskkill /F /IM python.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM ── Pull latest code (force reset — no merge conflicts) ────────
echo  [1] Pulling latest code from GitHub...
git fetch origin claude/backup-deploy-server-FWgpv >nul 2>&1
git reset --hard origin/claude/backup-deploy-server-FWgpv >nul 2>&1
echo  [1] Code up to date.

REM ── Start server ───────────────────────────────────────────────
echo  [2] Starting SmartEntry server...
start "SmartEntry Server" cmd /k "cd /d "%~dp0server" && node index.js"
timeout /t 8 /nobreak >nul

REM ── Verify server is up ────────────────────────────────────────
curl -s --max-time 6 http://localhost:3001/api/signals >nul 2>&1
if errorlevel 1 (
  echo  [2] WARNING: server not responding yet — check the server window
) else (
  echo  [2] Server: ONLINE — http://localhost:3001/dashboard
)

REM ── Open dashboard in browser ──────────────────────────────────
echo  [3] Opening dashboard...
start "" "http://localhost:3001/dashboard"
timeout /t 2 /nobreak >nul

REM ── Start watchdog ─────────────────────────────────────────────
echo  [4] Starting watchdog (auto-restarts server if it crashes)...
start "SmartEntry Watchdog" /min cmd /c "tasks\watchdog.bat"

REM ── Launch MT5 if not running ──────────────────────────────────
echo  [5] Checking MetaTrader 5...
tasklist /fi "imagename eq terminal64.exe" 2>nul | find /i "terminal64.exe" >nul
if errorlevel 1 (
  echo  [5] MT5 not running — launching...
  if exist "C:\Program Files\MetaTrader 5\terminal64.exe" (
    start "" /min "C:\Program Files\MetaTrader 5\terminal64.exe"
    echo  [5] MT5 launched — waiting 30 seconds to connect...
    timeout /t 30 /nobreak >nul
  ) else if exist "C:\Program Files (x86)\MetaTrader 5\terminal64.exe" (
    start "" /min "C:\Program Files (x86)\MetaTrader 5\terminal64.exe"
    echo  [5] MT5 launched — waiting 30 seconds to connect...
    timeout /t 30 /nobreak >nul
  ) else (
    echo  [5] MT5 not found — open it manually, then run tasks\start_bridge.bat
    goto :done
  )
) else (
  echo  [5] MT5 already running.
)

REM ── Start MT5 bridge in full-auto mode ─────────────────────────
echo  [6] Starting MT5 bridge (full-auto)...
start "SmartEntry Bridge" /min cmd /k "cd /d "%~dp0" && python mt5_bridge.py --auto"
timeout /t 3 /nobreak >nul
echo  [6] Bridge: running in background.

:done
echo.
echo  ==========================================
echo   SMARTENTRY PRO IS LIVE
echo   Dashboard:  http://localhost:3001/dashboard
echo   Logs:       tasks\logs\
echo   To stop:    close the server window
echo  ==========================================
echo.
REM If run manually, pause so the user can read the output.
REM If auto-started at login (no interactive session), skip the pause.
echo %SESSIONNAME% | findstr /i "Console RDP" >nul 2>&1
if not errorlevel 1 (
  pause
)
