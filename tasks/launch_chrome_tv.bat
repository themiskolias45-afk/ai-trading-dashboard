@echo off
title Launch Chrome for TradingView
cd /d C:\Users\User\ai-trading-dashboard

REM Close existing Chrome first (needed to relaunch with debug port)
taskkill /f /im chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Launch Chrome with remote debug port + open TradingView
echo  Launching Chrome with TradingView...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\User\AppData\Local\Google\Chrome\User Data" ^
  --profile-directory=Default ^
  --start-maximized ^
  "https://www.tradingview.com/chart/"

echo  Chrome launched. TradingView is opening...
echo  JARVIS can now draw on your charts with /draw
echo.
