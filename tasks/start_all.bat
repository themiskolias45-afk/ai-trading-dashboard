@echo off
title SmartEntry Pro - Manual Start
cd /d C:\Users\User\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

echo.
echo  ==========================================
echo   SmartEntry Pro - Starting Everything...
echo  ==========================================
echo.

REM 1 — Server
echo  [1/4] Starting server...
taskkill /f /fi "windowtitle eq SmartEntry Server" >nul 2>&1
start "SmartEntry Server" /min cmd /c "cd server && node index.js >> tasks\logs\server_log.txt 2>&1"
timeout /t 8 /nobreak >nul
curl -s --max-time 5 http://localhost:3001/api/signals >nul 2>&1
if errorlevel 1 (echo  [1/4] Server: FAILED - check tasks\logs\server_log.txt) else (echo  [1/4] Server: OK - http://localhost:3001/dashboard)

REM 2 — Watchdog
echo  [2/4] Starting watchdog...
taskkill /f /fi "windowtitle eq SmartEntry Watchdog" >nul 2>&1
start "SmartEntry Watchdog" /min cmd /c "tasks\watchdog.bat"
echo  [2/4] Watchdog: OK - auto-restarts server if it crashes

REM 3 — MT5
echo  [3/4] Checking MT5...
tasklist /fi "imagename eq terminal64.exe" 2>nul | find /i "terminal64.exe" >nul
if errorlevel 1 (
  echo  [3/4] MT5: launching...
  if exist "C:\Program Files\MetaTrader 5\terminal64.exe" (
    start "" /min "C:\Program Files\MetaTrader 5\terminal64.exe"
    echo  [3/4] MT5: started - waiting 30s to connect...
    timeout /t 30 /nobreak >nul
  ) else (
    echo  [3/4] MT5: NOT FOUND - open MT5 manually then run tasks\start_bridge.bat
    goto :summary
  )
) else (
  echo  [3/4] MT5: already running
)

REM 4 — Bridge
echo  [4/4] Starting MT5 bridge...
taskkill /f /fi "windowtitle eq SmartEntry Bridge" >nul 2>&1
start "SmartEntry Bridge" /min cmd /c "python mt5_bridge.py --auto >> tasks\logs\bridge_log.txt 2>&1"
timeout /t 5 /nobreak >nul
echo  [4/4] Bridge: OK - watching for signals

:summary
echo.
echo  ==========================================
echo   Done.
echo   Server:    http://localhost:3001/dashboard
echo   Logs:      tasks\logs\
echo   Bridge:    tasks\logs\bridge_log.txt
echo   Watchdog:  tasks\logs\watchdog_log.txt
echo  ==========================================
echo.
pause
