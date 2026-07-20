@echo off
title SmartEntry MT5 Bridge - AUTO MODE
cd /d C:\Users\User\ai-trading-dashboard
echo.
echo  SmartEntry MT5 Bridge - FULL AUTO MODE
echo  STRONG signals execute instantly. Semi-auto for MODERATE.
echo  Risk: 1%% per trade. Circuit breaker: 3 consecutive losses.
echo  Press Ctrl+C to stop.
echo.
python mt5_bridge.py --auto
pause
