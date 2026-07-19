@echo off
title SmartEntry Pro - Evening Report
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
if not exist tasks\logs mkdir tasks\logs
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - EVENING REPORT
echo   %date%
echo  ==========================================
echo.

echo  Fetching end-of-day data...
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/risk-status | ConvertTo-Json -Depth 10 | Out-File tasks\temp\risk.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\risk.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/mt5/positions | ConvertTo-Json -Depth 10 | Out-File tasks\temp\positions.json -Encoding utf8 } catch { '[]' | Out-File tasks\temp\positions.json -Encoding utf8 }"
echo.

claude --allowedTools "Read,Write" -p "JARVIS: Evening trading review. Read tasks/temp/risk.json, tasks/temp/positions.json, server/journal.json (if exists). Produce end-of-day report: == TODAY'S RESULTS == (trades taken today, total P&L, win/loss). == OPEN POSITIONS == (any positions still open overnight - flag as RISK if more than 1 open). == DAY GRADE == (A/B/C/D/F with one reason). == WHAT WORKED == (one thing that went well). == WHAT TO FIX == (one specific thing to improve tomorrow). == TOMORROW PREP == (key levels to watch for BTC/Gold/SPY). Save to tasks/logs/evening_%DATE:~-4,4%%DATE:~-10,2%%DATE:~-7,2%.txt"

echo.
echo  Report saved to tasks\logs\
echo.

REM Ask about overnight positions
echo  ==========================================
set /p CLOSE=" Any open positions to close before end of day? (Y/N): "
if /i "%CLOSE%"=="Y" (
  echo.
  echo  Open MT5 and close positions manually, then press any key.
  pause >nul
  echo  Positions closed. Good trading today.
)

echo.
pause
