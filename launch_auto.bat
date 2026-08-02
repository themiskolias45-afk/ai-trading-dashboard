@echo off
title SmartEntry Pro — AUTO LAUNCH
cd /d "C:\Users\User\ai-trading-dashboard"

REM ── Load API keys ─────────────────────────────────────────────
if exist keys.env (
  for /f "tokens=1,* delims==" %%a in (keys.env) do set "%%a=%%b"
)
if exist server\apikey.txt (
  set /p ANTHROPIC_API_KEY=<server\apikey.txt
)

REM ── Stop only our own previous processes ───────────────────────
REM These three lines used to be `taskkill /F /IM node.exe /T` and the same for
REM python.exe and terminal64.exe — by IMAGE NAME, which kills every node, every
REM python and every MetaTrader on the machine: both live bridges, both terminals,
REM every MCP server and any unrelated tool. START.bat had the identical bug removed
REM already; this file was missed. Window-title scoping matches tasks\watchdog.bat.
taskkill /F /FI "WINDOWTITLE eq SmartEntry Server*"     >nul 2>&1
taskkill /F /T /FI "WINDOWTITLE eq SmartEntry Bridge*"     >nul 2>&1
taskkill /F /T /FI "WINDOWTITLE eq SmartEntry MT5 Bridge*" >nul 2>&1
timeout /t 2 /nobreak >nul

REM ── Start MetaTrader 5 (try common install paths) ─────────────
if exist "C:\Program Files\MetaTrader 5\terminal64.exe" (
  start "" "C:\Program Files\MetaTrader 5\terminal64.exe"
) else if exist "C:\Program Files (x86)\MetaTrader 5\terminal64.exe" (
  start "" "C:\Program Files (x86)\MetaTrader 5\terminal64.exe"
) else if exist "%APPDATA%\MetaQuotes\Terminal\terminal64.exe" (
  start "" "%APPDATA%\MetaQuotes\Terminal\terminal64.exe"
) else (
  REM Search for terminal64.exe anywhere on C drive
  for /f "delims=" %%i in ('dir /s /b "C:\terminal64.exe" 2^>nul') do (
    start "" "%%i"
    goto mt5_started
  )
)
:mt5_started

REM ── Wait for MT5 to load before bridge connects ───────────────
echo  Waiting for MetaTrader 5 to load...
timeout /t 15 /nobreak >nul

REM ── Start SmartEntry server ───────────────────────────────────
start "SmartEntry Server" cmd /k "cd /d C:\Users\User\ai-trading-dashboard\server && node index.js"
timeout /t 8 /nobreak >nul

REM ── Open dashboard in browser ─────────────────────────────────
start "" "http://localhost:3001/dashboard"
timeout /t 2 /nobreak >nul

REM ── Start MT5 bridges — FULL AUTO, one per account ───────────
REM Was a single untagged `python mt5_bridge.py --auto`, which auto-detects
REM whichever terminal answers first, reports as account "default", and can open
REM every qualifying signal a second time on an account a tagged bridge already
REM owns. The tagged scripts pin terminal path and expected login.
start "" /min cmd /k "C:\Users\User\ai-trading-dashboard\tasks\start_bridge_A.bat"
timeout /t 3 /nobreak >nul
start "" /min cmd /k "C:\Users\User\ai-trading-dashboard\tasks\start_bridge_B.bat"
timeout /t 3 /nobreak >nul

REM ── Start JARVIS command center ───────────────────────────────
start "JARVIS - SmartEntry AI" cmd /k "cd /d C:\Users\User\ai-trading-dashboard && echo. && echo  JARVIS booting... && echo. && claude"

echo.
echo  ==========================================
echo   SmartEntry Pro — ALL SYSTEMS RUNNING
echo  ==========================================
echo   MT5        : started
echo   Server     : http://localhost:3001
echo   Dashboard  : http://localhost:3001/dashboard
echo   MT5 Bridge : FULL AUTO mode
echo   JARVIS     : ready in AI window
echo  ==========================================
echo.
