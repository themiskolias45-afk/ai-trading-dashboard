@echo off
title SmartEntry MT5 Bridge
cd /d "%~dp0"

echo.
echo  SmartEntry MT5 Bridge
echo  ----------------------
echo  Make sure MetaTrader 5 is open and logged in first.
echo.

REM Check if MetaTrader5 Python package is installed
python -c "import MetaTrader5" 2>nul
if errorlevel 1 (
    echo Installing required packages...
    pip install MetaTrader5 requests colorama
    echo.
)

REM Start the bridge for a specific account. Passing no ACCOUNT_TAG lets the bridge
REM auto-detect whichever MT5 terminal answers first: it then reports as account
REM "default", keeps its own circuit-breaker counter, and can open every qualifying
REM signal a SECOND time on an account a tagged bridge already owns. Both accounts
REM are defined once, in the tagged scripts — this file only chooses between them.
if /i "%~1"=="A" goto :run
if /i "%~1"=="B" goto :run

echo  Usage:  start_mt5.bat A ^| B         (full-auto)
echo          set BRIDGE_MODE=SEMI first  (confirm each trade)
echo.
echo     A = account 25446287, Program Files terminal
echo     B = account 11581419, AppData terminal
echo.
pause
exit /b 1

:run
call "%~dp0tasks\start_bridge_%~1.bat"

pause
