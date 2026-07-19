@echo off
title SmartEntry Pro - Morning Routine
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
if not exist tasks\logs mkdir tasks\logs
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - MORNING ROUTINE
echo   %date% %time%
echo  ==========================================
echo.

echo  [1/5] Fetching market data...
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/prices | ConvertTo-Json -Depth 10 | Out-File tasks\temp\prices.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\prices.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\signals.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/risk-status | ConvertTo-Json -Depth 10 | Out-File tasks\temp\risk.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\risk.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/plan | ConvertTo-Json -Depth 10 | Out-File tasks\temp\plan.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\plan.json -Encoding utf8 }"
echo  [2/5] Data fetched.
echo  [3/5] Running Claude morning analysis...
echo.

claude --allowedTools "Read,Write" -p "JARVIS: Run the full SmartEntry Pro morning routine. Read: tasks/temp/prices.json, tasks/temp/signals.json, tasks/temp/risk.json, tasks/temp/plan.json, server/journal.json (if exists). Produce a professional morning brief with these exact sections: == PRICES == (BTC, Gold, SPY, DXY, VIX with 24h change). == SIGNALS == (each asset: setup, confidence, entry/stop/target, R:R - mark [TRADE NOW] if confidence >= 65, [WATCH] if 40-64, [WAIT] if below 40 - for WAIT setups explain what specific condition would trigger them). == RISK BUDGET == (daily PnL, consecutive losses, max loss remaining today). == MARKET REGIME == (trending/ranging/squeeze for each asset, what that means for strategy). == JOURNAL == (last 3 trades if available). == TODAY'S PLAN == (max 3 bullet points: what to watch, what to avoid, one key level per asset). Then save this full brief to tasks/logs/morning_%DATE:~-4,4%%DATE:~-10,2%%DATE:~-7,2%.txt"

echo.
echo  [4/5] Opening report in Notepad...
set LOGFILE=tasks\logs\morning_%date:~-4,4%%date:~-10,2%%date:~-7,2%.txt
if exist "%LOGFILE%" (
  start notepad "%LOGFILE%"
) else (
  echo  Report not found - check tasks\logs\ folder
)
echo  [5/5] Done.
echo.
pause
