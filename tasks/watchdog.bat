@echo off
setlocal enabledelayedexpansion
title SmartEntry Watchdog
cd /d C:\Users\User\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

REM A bridge that was just restarted is not a dead bridge — it is a starting one.
REM A cold start costs the MT5 terminal launch plus the bridge's own connect retry
REM loop (6 attempts, 15s apart = 90s) before it can post a first heartbeat. With a
REM 60s cycle and no hold-off the watchdog kills it before it can ever report in,
REM and the restart itself becomes the thing keeping it down. That is not
REM theoretical: it is exactly what happened to Bridge B on the VPS, which logged
REM 3462 lines of startup banner and never one connect result. It has not bitten
REM this machine only because the local terminals are already logged in and connect
REM fast. Same guard, same reasoning. Raise this if you shorten the cycle below.
set BRIDGE_STARTUP_GRACE_CYCLES=3
set /a COOL_A=0
set /a COOL_B=0

echo [%date% %time%] Watchdog started. >> tasks\logs\watchdog_log.txt

:loop
REM Check if server responds (5 second timeout)
curl -s --max-time 5 http://localhost:3001/api/signals >nul 2>&1

if errorlevel 1 (
    echo [!date! !time!] SERVER DOWN — restarting... >> tasks\logs\watchdog_log.txt
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
        echo [!date! !time!] RESTART FAILED — server still down. >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Restart failed. Check tasks\logs\server_log.txt
    ) else (
        echo [!date! !time!] Server recovered OK. >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Server back online.
    )
)

REM ── MT5 bridge watchdog — restart only the specific account that went stale ──
REM /api/mt5/health returns 503 only once a PREVIOUSLY-connected bridge goes silent
REM (never-connected-yet is 200, so a slow first boot never triggers a false restart).
if !COOL_A! GTR 0 (
    set /a COOL_A-=1
) else (
    curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=A" >nul 2>&1
    if errorlevel 1 (
        echo [!date! !time!] BRIDGE A DOWN — restarting... >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Bridge A down — restarting...
        taskkill /f /fi "windowtitle eq SmartEntry MT5 Bridge - ACCOUNT A*" >nul 2>&1
        timeout /t 2 /nobreak >nul
        start "" /min cmd /k "tasks\start_bridge_A.bat"
        set /a COOL_A=!BRIDGE_STARTUP_GRACE_CYCLES!
        echo [!date! !time!] Bridge A restart triggered - holding off !BRIDGE_STARTUP_GRACE_CYCLES! cycles. >> tasks\logs\watchdog_log.txt
    )
)

if !COOL_B! GTR 0 (
    set /a COOL_B-=1
) else (
    curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=B" >nul 2>&1
    if errorlevel 1 (
        echo [!date! !time!] BRIDGE B DOWN — restarting... >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Bridge B down — restarting...
        taskkill /f /fi "windowtitle eq SmartEntry MT5 Bridge - ACCOUNT B*" >nul 2>&1
        timeout /t 2 /nobreak >nul
        start "" /min cmd /k "tasks\start_bridge_B.bat"
        set /a COOL_B=!BRIDGE_STARTUP_GRACE_CYCLES!
        echo [!date! !time!] Bridge B restart triggered - holding off !BRIDGE_STARTUP_GRACE_CYCLES! cycles. >> tasks\logs\watchdog_log.txt
    )
)

REM Check every 60 seconds
timeout /t 60 /nobreak >nul
goto loop
