@echo off
title SmartEntry Pro - Diagnose Signal Blocks
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - SIGNAL DIAGNOSTICS
echo   Why are signals blocked?
echo  ==========================================
echo.

echo  Fetching live data...
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\signals.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/prices | ConvertTo-Json -Depth 10 | Out-File tasks\temp\prices.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\prices.json -Encoding utf8 }"
echo.

claude --dangerously-skip-permissions -p "JARVIS: Diagnose why SmartEntry Pro signals are blocked. Read tasks/temp/signals.json and tasks/temp/prices.json. For EACH asset (BTC, Gold, SPY): 1) Current setup and confidence. 2) If WAIT - list EXACTLY what conditions are not met for each of these setups: BUY_DIP (needs uptrend + RSI<50 + near EMA20 + MACD bullish), BUY_OVERSOLD (needs RSI<30 + at BB lower), RANGE_TRADE_LONG (needs RSI<42 + at BB lower), SELL_BOUNCE (needs downtrend + RSI>50 + near EMA20), BREAKOUT (needs EMA200 reclaim + volume + squeeze). 3) Which condition is CLOSEST to being met. 4) What price level would trigger the next signal. Be specific with numbers. Max 40 lines."

echo.
pause
