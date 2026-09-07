@echo off
title SmartEntry Pro - Daily Check
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
if not exist tasks\logs mkdir tasks\logs
echo.
echo  ==========================================
echo   SmartEntry Pro - DAILY SYSTEM CHECK
echo  ==========================================
echo.

REM Fetch live data with PowerShell (no Claude permission needed)
echo  Fetching live data...
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { '{\"error\":\"server offline\"}' | Out-File tasks\temp\signals.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/risk-status | ConvertTo-Json -Depth 10 | Out-File tasks\temp\risk.json -Encoding utf8 } catch { '{\"error\":\"server offline\"}' | Out-File tasks\temp\risk.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/prices | ConvertTo-Json -Depth 10 | Out-File tasks\temp\prices.json -Encoding utf8 } catch { '{\"error\":\"server offline\"}' | Out-File tasks\temp\prices.json -Encoding utf8 }"
echo  Data fetched. Running Claude analysis...
echo.

REM Claude reads the saved files - no HTTP permission needed
call claude --dangerously-skip-permissions -p "JARVIS: Analyse this SmartEntry Pro data. Read these files: tasks/temp/signals.json (live signals), tasks/temp/risk.json (risk status), tasks/temp/prices.json (prices), server/journal.json (trade history - may not exist yet). Report: 1) Live prices for BTC/Gold/SPY. 2) Each signal: direction, confidence, setup, entry/stop/target, R:R. Mark ** ACTIONABLE ** if confidence >= 65. 3) Risk status: daily P&L, consecutive losses, halted. 4) Last 3 journal trades if available. 5) One-line verdict: TRADE TODAY or WAIT. Max 30 lines."

echo.
echo  Report saved to: tasks\logs\
call claude --dangerously-skip-permissions -p "JARVIS: Read tasks/temp/signals.json and tasks/temp/risk.json. Write a one-paragraph summary to tasks/logs/daily_%DATE:~-4,4%%DATE:~-10,2%%DATE:~-7,2%.txt with today's signal status, risk status, and recommendation. No more than 5 sentences."

echo.
pause
