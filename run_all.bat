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
REM Both modes go through the tagged scripts. Calling mt5_bridge.py directly from
REM here started an UNTAGGED bridge: it auto-detects whichever MT5 terminal answers
REM first, reports as account "default", and can open every qualifying signal a
REM second time on an account a tagged bridge already owns. BRIDGE_ARGS is the only
REM difference between the two modes; account identity stays defined in one place.
if "%MODE%"=="2" (
  echo  [3/3] Starting MT5 bridges A and B in FULL-AUTO mode...
  set "BRIDGE_MODE=AUTO"
) else (
  echo  [3/3] Starting MT5 bridges A and B in SEMI-AUTO mode...
  set "BRIDGE_MODE=SEMI"
)
start "" /min cmd /k "%~dp0tasks\start_bridge_A.bat"
timeout /t 3 /nobreak >nul
start "" /min cmd /k "%~dp0tasks\start_bridge_B.bat"
echo  Bridges A and B: running in background.
