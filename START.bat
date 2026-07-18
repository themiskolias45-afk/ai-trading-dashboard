@echo off
title SmartEntry Pro — AUTO START
cd /d "%~dp0"

REM Load API keys
if exist keys.env (
  for /f "tokens=1,* delims==" %%a in (keys.env) do set "%%a=%%b"
)
if exist server\apikey.txt (
  set /p ANTHROPIC_API_KEY=<server\apikey.txt
)

REM Kill any previous instance silently
taskkill /F /IM node.exe   /T >nul 2>&1
taskkill /F /IM python.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM Start server
start "SmartEntry Server" cmd /k "cd /d "%~dp0server" && node index.js"
timeout /t 7 /nobreak >nul

REM Open dashboard in browser
start "" "http://localhost:3001"

REM Start MT5 bridge in FULL-AUTO mode — no questions
echo.
echo  SmartEntry Pro started in FULL-AUTO mode.
echo  Dashboard: http://localhost:3001
echo  To stop:   double-click stop.bat
echo.
python mt5_bridge.py --auto
