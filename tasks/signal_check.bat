@echo off
title SmartEntry Pro - Signal Check
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
echo.
echo  ==========================================
echo   SmartEntry Pro - LIVE SIGNALS
echo  ==========================================
echo.

echo  Fetching signals and prices...
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { '{\"error\":\"server offline\"}' | Out-File tasks\temp\signals.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/prices | ConvertTo-Json -Depth 10 | Out-File tasks\temp\prices.json -Encoding utf8 } catch { '{\"error\":\"server offline\"}' | Out-File tasks\temp\prices.json -Encoding utf8 }"
echo.

claude --dangerously-skip-permissions -p "JARVIS: Read tasks/temp/signals.json and tasks/temp/prices.json. Output a clean signal table: Asset | Price | Signal | Setup | Confidence | Entry | Stop | Target | R:R | Trend. Mark any row with confidence >= 65 as [ACTIONABLE]. If server is offline say so. Max 15 lines."

echo.
pause
