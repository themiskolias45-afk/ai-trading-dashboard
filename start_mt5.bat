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

REM Start in semi-auto mode (confirm each trade)
REM To use full-auto mode: add --auto flag at the end
python mt5_bridge.py %*

pause
