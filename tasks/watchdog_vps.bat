@echo off
setlocal enabledelayedexpansion

set LOG=C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt

REM A bridge that has just been restarted is not "down" — it is still starting.
REM Cold start costs 5s to launch the MT5 terminal plus the bridge's own retry
REM loop (6 attempts, 15s apart = 90s) before it can post its first heartbeat.
REM With a 60s watchdog cycle and no hold-off, the watchdog kills the bridge at
REM 60s every single time and it can never reach the point of reporting in —
REM which is exactly what happened to Bridge B: 3462 log lines of nothing but
REM the startup banner. Hold off 3 cycles (~180s) after each restart.
REM If you shorten the cycle below, raise this to match.
set BRIDGE_STARTUP_GRACE_CYCLES=3
set /a COOL_A=0
set /a COOL_B=0

if not exist C:\ai-trading-dashboard\tasks\logs mkdir C:\ai-trading-dashboard\tasks\logs
echo [%date% %time%] VPS Watchdog started. >> %LOG%

:loop
curl -s --max-time 5 http://localhost:3001/api/signals >nul 2>&1
if errorlevel 1 (
    echo [!date! !time!] SERVER DOWN - restarting via Task Scheduler... >> !LOG!
    schtasks /end /tn SmartEntryServer >nul 2>&1
    timeout /t 3 /nobreak >nul
    schtasks /run /tn SmartEntryServer >nul 2>&1
    timeout /t 12 /nobreak >nul

    curl -s --max-time 8 http://localhost:3001/api/signals >nul 2>&1
    if errorlevel 1 (
        echo [!date! !time!] RESTART FAILED - server still down. >> !LOG!
    ) else (
        echo [!date! !time!] Server recovered OK. >> !LOG!
    )
)

REM -- MT5 bridge watchdog, same 503-only-after-connected logic as the local setup --
if !COOL_A! GTR 0 (
    set /a COOL_A-=1
) else (
    call :is_task_enabled SmartEntryBridgeA
    if !TASK_ENABLED! EQU 1 (
        curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=A" >nul 2>&1
        if errorlevel 1 (
            echo [!date! !time!] BRIDGE A DOWN - restarting... >> !LOG!
            schtasks /end /tn SmartEntryBridgeA >nul 2>&1
            timeout /t 2 /nobreak >nul
            schtasks /run /tn SmartEntryBridgeA >nul 2>&1
            set /a COOL_A=!BRIDGE_STARTUP_GRACE_CYCLES!
            echo [!date! !time!] Bridge A restart triggered - holding off !BRIDGE_STARTUP_GRACE_CYCLES! cycles. >> !LOG!
        )
    )
)

if !COOL_B! GTR 0 (
    set /a COOL_B-=1
) else (
    call :is_task_enabled SmartEntryBridgeB
    if !TASK_ENABLED! EQU 1 (
        curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=B" >nul 2>&1
        if errorlevel 1 (
            echo [!date! !time!] BRIDGE B DOWN - restarting... >> !LOG!
            schtasks /end /tn SmartEntryBridgeB >nul 2>&1
            timeout /t 2 /nobreak >nul
            schtasks /run /tn SmartEntryBridgeB >nul 2>&1
            set /a COOL_B=!BRIDGE_STARTUP_GRACE_CYCLES!
            echo [!date! !time!] Bridge B restart triggered - holding off !BRIDGE_STARTUP_GRACE_CYCLES! cycles. >> !LOG!
        )
    )
)

timeout /t 60 /nobreak >nul
goto loop

REM A bridge whose Scheduled Task is disabled was switched off deliberately — that
REM is an operator decision, not a fault. schtasks /run on a disabled task fails
REM into >nul, so without this check the watchdog logs "restart triggered" for a
REM restart that never happened, and watchdog_log.txt reads like a crash-loop
REM forever. A task that no longer exists is treated the same way, so a deleted
REM task cannot start a restart storm either.
:is_task_enabled
powershell -NoProfile -Command "$t = Get-ScheduledTask -TaskName '%~1' -ErrorAction SilentlyContinue; if ($t -and $t.State -ne 'Disabled') { exit 0 } else { exit 1 }"
if errorlevel 1 (set TASK_ENABLED=0) else (set TASK_ENABLED=1)
goto :eof
