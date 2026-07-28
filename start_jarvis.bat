@echo off
cd /d C:\Users\User\ai-trading-dashboard

REM Load environment
if exist keys.env (
    for /f "usebackq tokens=1,* delims==" %%a in ("keys.env") do set "%%a=%%b"
)

REM Start server if not running
curl -s --max-time 2 http://localhost:3001/api/health >nul 2>&1
if errorlevel 1 (
    echo Starting server...
    start "" /min cmd /c "cd /d C:\Users\User\ai-trading-dashboard\server && node index.js >> C:\Users\User\ai-trading-dashboard\tasks\logs\server_log.txt 2>&1"
    timeout /t 4 /nobreak >nul
)

REM Start MT5 bridge if not running
tasklist /fi "imagename eq python.exe" 2>nul | find /i "python" >nul
if errorlevel 1 (
    echo Starting MT5 bridge...
    start "" /min cmd /c "cd /d C:\Users\User\ai-trading-dashboard && python mt5_bridge.py --auto >> tasks\logs\bridge_log.txt 2>&1"
)

REM Open JARVIS
claude
