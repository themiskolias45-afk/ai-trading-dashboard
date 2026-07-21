@echo off
title Launch Edge for TradingView
cd /d C:\Users\User\ai-trading-dashboard

REM Close existing Edge first (needed to relaunch with debug port)
taskkill /f /im msedge.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Launch Edge with remote debug port + open TradingView
echo  Launching Edge with TradingView...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\User\AppData\Local\Microsoft\Edge\User Data" ^
  --profile-directory=Default ^
  --start-maximized ^
  "https://www.tradingview.com/chart/"

echo  Edge launched. TradingView is opening...
echo  JARVIS can now draw on your charts with /draw
echo.
