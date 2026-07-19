@echo off
title SmartEntry Pro — Risk Check
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   SmartEntry Pro — RISK STATUS
echo  ==========================================
echo.
claude -p "JARVIS: Fetch http://localhost:3001/api/risk-status and http://localhost:3001/api/mt5/positions. Show: 1) Daily P&L vs 3%% limit ($2700 on $90k). 2) Consecutive losses vs 3-loss limit. 3) Is system halted? Why? 4) All open MT5 positions with unrealised P&L. 5) Total open risk exposure. 6) Green/Yellow/Red status — is it safe to keep trading today? One word verdict at the top: SAFE / CAUTION / HALT."
echo.
pause
