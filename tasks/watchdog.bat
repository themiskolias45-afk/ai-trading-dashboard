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

REM Check every 60 seconds
timeout /t 60 /nobreak >nul
goto loop
