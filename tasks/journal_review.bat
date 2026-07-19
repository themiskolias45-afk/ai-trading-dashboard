@echo off
title SmartEntry Pro — Journal Review
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   SmartEntry Pro — TRADE JOURNAL REVIEW
echo  ==========================================
echo.
claude -p "JARVIS: Read server/journal.json. Calculate and show: 1) Total trades, wins, losses, win rate. 2) Total P&L and average P&L per trade. 3) Best trade and worst trade. 4) Breakdown by asset (BTC/Gold/SPX) — win rate per asset. 5) Any losing streak of 2 or more in a row. 6) One concrete improvement based on the patterns you see. Keep it under 35 lines."
echo.
pause
