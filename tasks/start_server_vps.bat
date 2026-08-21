@echo off
cd /d C:\ai-trading-dashboard

REM Idempotence guard. This task fires AtLogon and AtBoot, but SmartEntryEnsureRunning
REM (SYSTEM, every 10 minutes) is what actually keeps the server alive and normally wins
REM the race. node then cannot bind 3001, exits non-zero, and the task records 0x1 -
REM which the coverage audit reported as a RED on a box whose server was healthy the
REM whole time. A permanent false red is worse than no check at all, so ask first.
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://localhost:3001/api/status' -UseBasicParsing -TimeoutSec 5; exit 0 } catch { exit 1 }"
if %ERRORLEVEL%==0 (
  echo [start_server_vps] %DATE% %TIME% server already answering on 3001 - nothing to do >> C:\ai-trading-dashboard\tasks\logs\server_log.txt
  exit /b 0
)

if exist keys.env (
  for /f "usebackq tokens=1,* delims==" %%a in ("keys.env") do set "%%a=%%b"
)
if exist server\apikey.txt (
  set /p ANTHROPIC_API_KEY=<server\apikey.txt
)

cd server
if not exist node_modules\ (
    echo Installing npm packages...
    npm install >> C:\ai-trading-dashboard\tasks\logs\server_log.txt 2>&1
)
node index.js >> C:\ai-trading-dashboard\tasks\logs\server_log.txt 2>&1
