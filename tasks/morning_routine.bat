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

echo  Fetching market data...
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/prices | ConvertTo-Json -Depth 10 | Out-File tasks\temp\prices.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\prices.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\signals.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/risk-status | ConvertTo-Json -Depth 10 | Out-File tasks\temp\risk.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\risk.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/plan | ConvertTo-Json -Depth 10 | Out-File tasks\temp\plan.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\plan.json -Encoding utf8 }"
echo  Done. Running Claude analysis...
echo.

REM Close any open Notepad that may be locking the file
taskkill /F /IM notepad.exe >nul 2>&1
timeout /t 1 /nobreak >nul

REM Save report to fixed filename — always easy to find
claude --dangerously-skip-permissions -p "JARVIS: Morning brief. Read tasks/temp/prices.json, tasks/temp/signals.json, tasks/temp/risk.json, tasks/temp/plan.json, server/journal.json (if exists). Output sections: == PRICES == (BTC Gold SPY DXY VIX). == SIGNALS == (each asset: setup confidence entry/stop/target R:R — mark [TRADE NOW] if conf>=65, [WATCH] 40-64, [WAIT] below 40, for WAIT list exact condition to trigger). == RISK BUDGET == (daily PnL, consecutive losses, room left today). == MARKET REGIME == (trending/ranging/squeeze per asset). == TODAY PLAN == (3 bullets: what to watch, what to avoid, key level per asset)." > tasks\logs\morning_latest.txt

echo.
echo  ==========================================
echo   REPORT READY — opening in Notepad
echo  ==========================================
echo.

REM Show in terminal too
type tasks\logs\morning_latest.txt

echo.
echo  ==========================================
REM Open in Notepad for comfortable reading
start notepad tasks\logs\morning_latest.txt

echo  Press any key to return to menu...
pause >nul
