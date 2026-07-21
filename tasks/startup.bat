@echo off
title SmartEntry Pro - Auto Startup
cd /d C:\Users\User\ai-trading-dashboard

if not exist tasks\logs mkdir tasks\logs
echo [%date% %time%] SmartEntry startup... >> tasks\logs\startup_log.txt

REM 1 — Start Node server in background
echo  Starting SmartEntry server...
start "SmartEntry Server" /min cmd /c "cd server && node index.js >> ..\tasks\logs\server_log.txt 2>&1"

REM 2 — Wait for server to boot
timeout /t 8 /nobreak >nul

REM 3 — Launch Edge with TradingView (dedicated SmartEntryTV profile + debug port)
REM     Dedicated profile = always its own process, port 9222 always binds correctly
echo  Launching Edge with TradingView...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\User\AppData\Local\Microsoft\Edge\SmartEntryTV" ^
  --no-first-run ^
  --start-maximized ^
  "https://www.tradingview.com/chart/"

REM 4 — Start watchdog (monitors server, auto-restarts if it crashes)
echo  Starting server watchdog...
start "SmartEntry Watchdog" /min cmd /c "tasks\watchdog.bat"

REM 4 — Backup data
call tasks\backup_data.bat

REM 4 — Launch MT5 if not already running
tasklist /fi "imagename eq terminal64.exe" 2>nul | find /i "terminal64.exe" >nul
if errorlevel 1 (
  echo  MT5 not running — launching...
  REM MT5 install path (confirmed: C:\Program Files\MetaTrader 5)
  if exist "C:\Program Files\MetaTrader 5\terminal64.exe" (
    start "" /min "C:\Program Files\MetaTrader 5\terminal64.exe"
    goto :wait_mt5
  )
  if exist "C:\Program Files (x86)\MetaTrader 5\terminal64.exe" (
    start "" /min "C:\Program Files (x86)\MetaTrader 5\terminal64.exe"
    goto :wait_mt5
  )
  echo  MT5 not found — set path in tasks\startup.bat line 30. Bridge skipped.
  goto :done
)
echo  MT5 already running.
goto :start_bridge

:wait_mt5
echo  Waiting 30 seconds for MT5 to connect...
timeout /t 30 /nobreak >nul

:start_bridge
echo  Starting MT5 bridge...
start "SmartEntry Bridge" /min cmd /c "python mt5_bridge.py --auto >> tasks\logs\bridge_log.txt 2>&1"

:done
echo [%date% %time%] Startup complete. >> tasks\logs\startup_log.txt
echo.
echo  SmartEntry Pro is running.
echo   Server:  http://localhost:3001/dashboard
echo   Bridge:  check tasks\logs\bridge_log.txt
echo   Logs:    tasks\logs\
echo.
