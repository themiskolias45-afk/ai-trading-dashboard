@echo off
title SmartEntry Pro
cd /d "%~dp0"

echo.
echo  ============================================
echo   SmartEntry Pro v12 — Full Trading System
echo  ============================================
echo.
echo  Commands:
echo    run_all.bat  = Start everything  (YOU ARE HERE)
echo    stop.bat     = Stop everything
echo.
echo  Dashboard: http://localhost:3001
echo.

REM Load API keys
if exist keys.env (
  for /f "tokens=1,* delims==" %%a in (keys.env) do set "%%a=%%b"
)
if exist server\apikey.txt (
  set /p ANTHROPIC_API_KEY=<server\apikey.txt
)

REM Start the server in a separate window (stays open)
start "SmartEntry Server" cmd /k "cd /d "%~dp0server" && node index.js"

echo  [1/3] Server starting...
timeout /t 6 /nobreak > nul

REM Open dashboard in browser
start "" "http://localhost:3001"
echo  [2/3] Dashboard opened in browser

echo.
echo  Choose MT5 trading mode:
echo    1 = Semi-auto  (YOU confirm each trade before it executes)
echo    2 = Full-auto  (STRONG signals execute automatically)
echo.
set /p MODE="  Enter 1 or 2 [default=1]: "

echo.
if "%MODE%"=="2" (
  echo  [3/3] Starting MT5 bridge in FULL-AUTO mode...
  python mt5_bridge.py --auto
) else (
  echo  [3/3] Starting MT5 bridge in SEMI-AUTO mode...
  python mt5_bridge.py
)
