@echo off
title SmartEntry Pro — Signal Check
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   SmartEntry Pro — LIVE SIGNALS
echo  ==========================================
echo.
claude -p "JARVIS: Fetch http://localhost:3001/api/signals and http://localhost:3001/api/prices. For each asset (BTC, Gold, SPY): show current price, signal direction, setup name, confidence %, entry/stop/target, R:R ratio, and trend. Flag any signal with confidence >= 65 as ACTIONABLE. Output as a clean table. Max 20 lines total."
echo.
pause
