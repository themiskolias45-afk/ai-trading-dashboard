@echo off
title SmartEntry Watchdog
cd /d C:\Users\User\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

echo [%date% %time%] Watchdog started. >> tasks\logs\watchdog_log.txt

:loop
REM Check if server responds (5 second timeout)
curl -s --max-time 5 http://localhost:3001/api/signals >nul 2>&1

if errorlevel 1 (
    echo [%date% %time%] SERVER DOWN — restarting... >> tasks\logs\watchdog_log.txt
    echo  [WATCHDOG] Server down — restarting...

    REM Kill only the SmartEntry Server window (safe — won't kill other node processes)
    taskkill /f /fi "windowtitle eq SmartEntry Server" >nul 2>&1
    timeout /t 3 /nobreak >nul

    REM Restart server
    start "SmartEntry Server" /min cmd /c "cd server && node index.js >> tasks\logs\server_log.txt 2>&1"
    timeout /t 12 /nobreak >nul

    REM Verify restart worked
    curl -s --max-time 8 http://localhost:3001/api/signals >nul 2>&1
    if errorlevel 1 (
        echo [%date% %time%] RESTART FAILED — server still down. >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Restart failed. Check tasks\logs\server_log.txt
    ) else (
        echo [%date% %time%] Server recovered OK. >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Server back online.
    )
)

REM ── MT5 bridge watchdog — restart only the specific account that went stale ──
REM /api/mt5/health returns 503 only once a PREVIOUSLY-connected bridge goes silent
REM (never-connected-yet is 200, so a slow first boot never triggers a false restart).
curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=A" >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] BRIDGE A DOWN — restarting... >> tasks\logs\watchdog_log.txt
    echo  [WATCHDOG] Bridge A down — restarting...
    taskkill /f /fi "windowtitle eq SmartEntry MT5 Bridge - ACCOUNT A*" >nul 2>&1
    timeout /t 2 /nobreak >nul
    start "" /min cmd /k "tasks\start_bridge_A.bat"
    echo [%date% %time%] Bridge A restart triggered. >> tasks\logs\watchdog_log.txt
)

curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=B" >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] BRIDGE B DOWN — restarting... >> tasks\logs\watchdog_log.txt
    echo  [WATCHDOG] Bridge B down — restarting...
    taskkill /f /fi "windowtitle eq SmartEntry MT5 Bridge - ACCOUNT B*" >nul 2>&1
    timeout /t 2 /nobreak >nul
    start "" /min cmd /k "tasks\start_bridge_B.bat"
    echo [%date% %time%] Bridge B restart triggered. >> tasks\logs\watchdog_log.txt
)

REM Check every 60 seconds
timeout /t 60 /nobreak >nul
goto loop
