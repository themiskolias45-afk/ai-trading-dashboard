@echo off
title SmartEntry MT5 Bridge - ACCOUNT B (AppData terminal)
cd /d C:\Users\User\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set ACCOUNT_TAG=B
set MT5_TERMINAL_PATH=C:\Users\User\AppData\Roaming\MetaTrader 5\terminal64.exe

echo.
echo  SmartEntry MT5 Bridge - ACCOUNT B - FULL AUTO MODE
echo  Terminal: %MT5_TERMINAL_PATH%
echo  STRONG signals execute instantly. Semi-auto for MODERATE.
echo  Risk: 1%% per trade. Circuit breaker: 3 consecutive losses.
echo  Press Ctrl+C to stop.
echo.
python mt5_bridge.py --auto
pause
