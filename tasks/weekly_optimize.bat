@echo off
title SmartEntry Pro - Weekly Optimization
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - WEEKLY OPTIMIZATION
echo   Run every Sunday before market open
echo  ==========================================
echo.

echo  Running backtest...
powershell -Command "try { Write-Host 'Fetching backtest data...'; $r = Invoke-RestMethod 'http://localhost:3001/api/backtest?force=1' -TimeoutSec 120; $r | ConvertTo-Json -Depth 10 | Out-File tasks\temp\backtest.json -Encoding utf8; Write-Host 'Backtest complete.' } catch { '{\"error\":\"failed\"}' | Out-File tasks\temp\backtest.json -Encoding utf8; Write-Host 'Backtest failed.' }"
echo.

echo  Analysing performance and generating improvement plan...
echo.

call claude --dangerously-skip-permissions -p "JARVIS: Weekly SmartEntry Pro strategy review. Read tasks/temp/backtest.json and server/journal.json. Produce the weekly optimization report: == PERFORMANCE THIS WEEK == (win rate, total P&L, trades per asset). == BACKTEST vs LIVE == (compare live results to backtest expectations - are they aligned?). == BEST SETUP == (which setup type won most this week: BUY_DIP/RANGE_TRADE/BREAKOUT etc). == WORST SETUP == (which setup lost most or had lowest win rate). == PARAMETER REVIEW == for each asset: are the RSI thresholds right for current volatility? Are stops too tight or too loose based on ATR? == NEXT WEEK PLAN == (3 specific adjustments to make this week). == MARKET OUTLOOK == (what regime are we likely in next week and what strategy fits). Max 50 lines, be specific with numbers."

echo.
echo  ==========================================
echo   Apply improvements?
echo  ==========================================
set /p IMPROVE=" Run improve_algo.bat now? (Y/N): "
if /i "%IMPROVE%"=="Y" call tasks\improve_algo.bat

echo.
pause
