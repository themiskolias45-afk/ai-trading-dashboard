@echo off
title SmartEntry Pro - Journal Review
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   SmartEntry Pro - TRADE JOURNAL REVIEW
echo  ==========================================
echo.

claude --dangerously-skip-permissions -p "JARVIS: Read server/journal.json. If it doesn't exist, say 'No trades recorded yet - journal created on first trade'. Otherwise calculate: 1) Total trades / wins / losses / win rate. 2) Total P&L and avg P&L per trade. 3) Best and worst trade. 4) Win rate per asset (BTC/Gold/SPX). 5) Any losing streak of 2 or more consecutive losses. 6) One concrete pattern you see (good or bad). Max 35 lines."

echo.
pause
