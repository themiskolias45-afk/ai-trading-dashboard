@echo off
title SmartEntry Pro - Backtest
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
echo.
echo  ==========================================
echo   SmartEntry Pro - RUN BACKTEST
echo  ==========================================
echo.

echo  Running backtest (takes 30-60 seconds)...
powershell -Command "try { Invoke-RestMethod 'http://localhost:3001/api/backtest?force=1' | ConvertTo-Json -Depth 10 | Out-File tasks\temp\backtest.json -Encoding utf8; Write-Host 'Done.' } catch { '{\"error\":\"server offline\"}' | Out-File tasks\temp\backtest.json -Encoding utf8; Write-Host 'Server offline.' }"

call claude --dangerously-skip-permissions -p "JARVIS: Read tasks/temp/backtest.json. For each asset (BTC, Gold, SPY) show: total trades, win rate, avg R:R, profit factor, max drawdown %%, total return %%. Then a PASS/FAIL check against: win rate > 50%%, profit factor > 1.5, max drawdown < 25%%. Show the 3 most recent backtest trades per asset. End with: which asset is strongest, which needs work. Max 40 lines."

echo.
pause
