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

echo  Done. Building report...
echo.

powershell -ExecutionPolicy Bypass -File tasks\morning.ps1

echo.
echo  ==========================================
set /p AIASK=" Want AI commentary? (Y/N): "
if /i "%AIASK%"=="Y" (
  echo  Running AI analysis...
  call claude --dangerously-skip-permissions -p "JARVIS: Read tasks/logs/morning_latest.txt. Give a 5-line trading brief: market regime, best opportunity today, main risk, one key price level to watch, one-line verdict."
)
echo.
echo  Report saved to: tasks\logs\morning_latest.txt
echo  Opening in Notepad...
taskkill /F /IM notepad.exe >nul 2>&1
start notepad tasks\logs\morning_latest.txt
echo.
echo  Press any key to return to menu...
pause >nul
