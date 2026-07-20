@echo off
title SmartEntry Pro - Auto Startup
cd /d C:\Users\User\ai-trading-dashboard

echo [%date% %time%] SmartEntry startup... >> tasks\logs\startup_log.txt

REM 1 — Start Node server in background
echo  Starting SmartEntry server...
start "SmartEntry Server" /min cmd /c "cd server && node index.js >> ..\tasks\logs\server_log.txt 2>&1"

REM 2 — Wait for server to boot
timeout /t 8 /nobreak >nul

REM 3 — Backup data
call tasks\backup_data.bat

REM 4 — Start MT5 bridge in auto mode (only if MT5 is running)
tasklist /fi "imagename eq terminal64.exe" 2>nul | find /i "terminal64.exe" >nul
if not errorlevel 1 (
  echo  MT5 detected — starting bridge...
  start "SmartEntry Bridge" /min cmd /c "python mt5_bridge.py --auto >> tasks\logs\bridge_log.txt 2>&1"
) else (
  echo  MT5 not running — bridge skipped. Open MT5 then run tasks\start_bridge.bat
)

echo [%date% %time%] Startup complete. >> tasks\logs\startup_log.txt
echo.
echo  SmartEntry Pro is running.
echo   Server:  http://localhost:3001/dashboard
echo   Bridge:  check tasks\logs\bridge_log.txt
echo   Logs:    tasks\logs\
echo.
