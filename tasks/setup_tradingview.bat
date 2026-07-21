@echo off
title Setup TradingView Access
cd /d C:\Users\User\ai-trading-dashboard
echo.
echo  ==========================================
echo   TradingView — JARVIS Full Access Setup
echo  ==========================================
echo.

REM Install playwright
echo  [1/3] Installing Playwright...
pip install playwright >nul 2>&1
playwright install chromium >nul 2>&1
echo  [1/3] Playwright: OK

REM Save credentials to keys.env (already gitignored)
echo.
echo  [2/3] TradingView credentials
echo   (stored in keys.env — never committed to git)
echo.
set /p TV_USER=  Enter your TradingView username or email:
set /p TV_PASS=  Enter your TradingView password:

REM Remove old TV lines from keys.env if they exist
if exist keys.env (
    powershell -Command "(Get-Content keys.env) | Where-Object { $_ -notmatch '^TV_' } | Set-Content keys.env"
) else (
    type nul > keys.env
)

REM Append credentials
echo TV_USERNAME=%TV_USER%>> keys.env
echo TV_PASSWORD=%TV_PASS%>> keys.env

echo  [2/3] Credentials saved to keys.env

REM Test login
echo.
echo  [3/3] Testing login — Chrome will open...
python tradingview_bot.py test

if errorlevel 1 (
    echo.
    echo  ERROR: Login failed. Check username/password and try again.
    pause
    exit /b 1
)

echo.
echo  ==========================================
echo   SUCCESS. JARVIS has full TradingView access.
echo.
echo   Commands:
echo     /draw BTC             Draw BTC daily plan on TradingView
echo     /draw GOLD            Draw Gold daily plan
echo     /draw SPX             Draw SPX daily plan
echo.
echo   In JARVIS terminal: just say
echo     "draw daily plan for BTC"
echo     "set up today's levels on TradingView"
echo  ==========================================
echo.
pause
