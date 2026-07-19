@echo off
title SmartEntry Pro - Daily Check
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   SmartEntry Pro - DAILY SYSTEM CHECK
echo  ==========================================
echo.
claude -p "JARVIS: Daily SmartEntry Pro check. Do all of these in order: 1) Read server/journal.json - show last 5 trades with P&L and outcome. 2) Fetch http://localhost:3001/api/signals - show BTC, Gold, SPY signal, confidence, setup, entry/stop/target. 3) Fetch http://localhost:3001/api/risk-status - show daily P&L, consecutive losses, halted status. 4) Check if any circuit breaker is close to triggering. 5) One-line recommendation for today. Keep the whole output under 30 lines."
echo.
pause
