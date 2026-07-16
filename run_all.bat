@echo off
title SmartEntry Pro — Starting...
cd /d "%~dp0"

echo.
echo  Starting SmartEntry Pro...
echo.

REM Load API keys
if exist keys.env (
  for /f "tokens=1,* delims==" %%a in (keys.env) do set "%%a=%%b"
)
if exist server\apikey.txt (
  set /p ANTHROPIC_API_KEY=<server\apikey.txt
)

REM Start the server in a new window
start "SmartEntry Server" cmd /c "cd /d "%~dp0server" && node index.js"

echo Waiting for server to start...
timeout /t 8 /nobreak > nul

REM Start MT5 bridge — use --auto for full auto, remove for semi-auto
echo.
echo  Choose trading mode:
echo  1 = Semi-auto (you confirm each trade)
echo  2 = Full-auto (executes STRONG signals automatically)
echo.
set /p MODE="Enter 1 or 2: "

if "%MODE%"=="2" (
  echo Starting in FULL-AUTO mode...
  python mt5_bridge.py --auto
) else (
  echo Starting in SEMI-AUTO mode...
  python mt5_bridge.py
)
