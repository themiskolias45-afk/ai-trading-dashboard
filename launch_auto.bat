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
taskkill /F /IM node.exe   /T >nul 2>&1
taskkill /F /IM python.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM ── Start server ───────────────────────────────────────────────
start "SmartEntry Server" cmd /k "cd /d C:\Users\User\ai-trading-dashboard\server && node index.js"
timeout /t 8 /nobreak >nul

REM ── Open dashboard in browser ──────────────────────────────────
start "" "http://localhost:3001/dashboard"
timeout /t 2 /nobreak >nul

REM ── Start MT5 bridge — FULL AUTO ──────────────────────────────
start "SmartEntry MT5" cmd /k "cd /d C:\Users\User\ai-trading-dashboard && python mt5_bridge.py --auto"

echo.
echo  SmartEntry Pro is running.
echo  Dashboard: http://localhost:3001/dashboard
echo.
