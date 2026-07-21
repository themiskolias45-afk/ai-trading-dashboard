@echo off
title Launch Edge for TradingView
cd /d C:\Users\User\ai-trading-dashboard

REM Use a dedicated profile folder so it doesn't conflict with your normal Edge
set TV_PROFILE=C:\Users\User\AppData\Local\Microsoft\Edge\SmartEntryTV

echo  Launching TradingView in Edge (dedicated profile)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%TV_PROFILE%" ^
  --no-first-run ^
  --start-maximized ^
  "https://www.tradingview.com/chart/"

REM Wait and verify port opened
timeout /t 4 /nobreak >nul
netstat -an | findstr 9222 >nul 2>&1
if errorlevel 1 (
  echo  WARNING: Port 9222 not detected — Edge may not have started correctly.
  echo  Try closing all Edge windows and running this again.
) else (
  echo  Edge ready on port 9222. JARVIS can now draw on your charts.
  echo  Log into TradingView in the Edge window that just opened.
)
echo.
