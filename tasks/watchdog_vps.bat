@echo off
if not exist C:\ai-trading-dashboard\tasks\logs mkdir C:\ai-trading-dashboard\tasks\logs
echo [%date% %time%] VPS Watchdog started. >> C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt

:loop
curl -s --max-time 5 http://localhost:3001/api/signals >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] SERVER DOWN - restarting via Task Scheduler... >> C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt
    schtasks /end /tn SmartEntryServer >nul 2>&1
    timeout /t 3 /nobreak >nul
    schtasks /run /tn SmartEntryServer >nul 2>&1
    timeout /t 12 /nobreak >nul

    curl -s --max-time 8 http://localhost:3001/api/signals >nul 2>&1
    if errorlevel 1 (
        echo [%date% %time%] RESTART FAILED - server still down. >> C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt
    ) else (
        echo [%date% %time%] Server recovered OK. >> C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt
    )
)

REM -- MT5 bridge watchdog, same 503-only-after-connected logic as the local setup --
curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=A" >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] BRIDGE A DOWN - restarting... >> C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt
    schtasks /end /tn SmartEntryBridgeA >nul 2>&1
    timeout /t 2 /nobreak >nul
    schtasks /run /tn SmartEntryBridgeA >nul 2>&1
    echo [%date% %time%] Bridge A restart triggered. >> C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt
)

curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=B" >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] BRIDGE B DOWN - restarting... >> C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt
    schtasks /end /tn SmartEntryBridgeB >nul 2>&1
    timeout /t 2 /nobreak >nul
    schtasks /run /tn SmartEntryBridgeB >nul 2>&1
    echo [%date% %time%] Bridge B restart triggered. >> C:\ai-trading-dashboard\tasks\logs\watchdog_log.txt
)

timeout /t 60 /nobreak >nul
goto loop
