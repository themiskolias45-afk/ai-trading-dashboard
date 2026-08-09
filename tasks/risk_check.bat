@echo off
title SmartEntry Pro - Risk Check
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
echo.
echo  ==========================================
echo   SmartEntry Pro - RISK STATUS
echo  ==========================================
echo.

echo  Fetching risk data...
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/risk-status | ConvertTo-Json -Depth 10 | Out-File tasks\temp\risk.json -Encoding utf8 } catch { '{\"error\":\"server offline\"}' | Out-File tasks\temp\risk.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/mt5/positions | ConvertTo-Json -Depth 10 | Out-File tasks\temp\positions.json -Encoding utf8 } catch { '{\"error\":\"no positions\"}' | Out-File tasks\temp\positions.json -Encoding utf8 }"
echo.

call claude --dangerously-skip-permissions -p "JARVIS: Read tasks/temp/risk.json and tasks/temp/positions.json. Show: VERDICT on first line (SAFE / CAUTION / HALT). Then: daily P&L vs $2700 limit (3% of $90k), consecutive losses vs 3-loss limit, is system halted and why, all open positions with unrealised P&L, total open risk. Flag anything within 20% of a limit as WARNING."

echo.
pause
