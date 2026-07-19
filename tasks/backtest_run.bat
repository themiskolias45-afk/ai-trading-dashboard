@echo off
title SmartEntry Pro — Backtest
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   SmartEntry Pro — RUN BACKTEST
echo  ==========================================
echo.
claude -p "JARVIS: Fetch http://localhost:3001/api/backtest?force=1 to run a fresh backtest. Show results for BTC, Gold, SPY: total trades, win rate, avg R:R, profit factor, max drawdown, total return. Compare to the minimum viable thresholds (win rate > 50%%, profit factor > 1.5, max drawdown < 25%%). Flag any asset that fails a threshold. Show the 5 most recent backtest trades per asset. Keep under 40 lines."
echo.
pause
