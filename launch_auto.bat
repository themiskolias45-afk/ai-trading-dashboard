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

REM ── Kill any previous instance ─────────────────────────────────
taskkill /F /IM node.exe      /T >nul 2>&1
taskkill /F /IM python.exe    /T >nul 2>&1
taskkill /F /IM terminal64.exe /T >nul 2>&1
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

REM ── Start MT5 bridge — FULL AUTO ─────────────────────────────
start "SmartEntry MT5 Bridge" cmd /k "cd /d C:\Users\User\ai-trading-dashboard && python mt5_bridge.py --auto"

echo.
echo  ==========================================
echo   SmartEntry Pro — ALL SYSTEMS RUNNING
echo  ==========================================
echo   MT5        : started
echo   Server     : http://localhost:3001
echo   Dashboard  : http://localhost:3001/dashboard
echo   MT5 Bridge : FULL AUTO mode
echo  ==========================================
echo.
