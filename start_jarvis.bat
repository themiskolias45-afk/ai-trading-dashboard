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

REM Start MT5 bridges if none are running.
REM Launch the TAGGED bridges, never a bare `python mt5_bridge.py`. An untagged
REM bridge auto-detects whichever MT5 terminal it finds first and lands on
REM #11581419 — the same account as Bridge B — so one signal opens two positions
REM and the 3-loss breaker splits across two risk tags. The tagged .bats pin both
REM the terminal path and MT5_EXPECTED_LOGIN, so a wrong-terminal attach refuses
REM to trade instead of silently doubling up.
tasklist /fi "imagename eq python.exe" 2>nul | find /i "python" >nul
if errorlevel 1 (
    echo Starting MT5 bridges A and B...
    start "" /min cmd /c "tasks\start_bridge_A.bat"
    start "" /min cmd /c "tasks\start_bridge_B.bat"
)

REM Open JARVIS
claude
