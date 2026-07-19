@echo off
title SmartEntry Pro - Algorithm Improvement
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   SmartEntry Pro - IMPROVE THE ALGORITHM
echo  ==========================================
echo.
claude -p "JARVIS: Analyse the trading algorithm and make one concrete improvement right now. Read server/index.js (signal engine) and server/journal.json (trade results). Find the single biggest weakness - low win rate setup, bad stop placement, missing filter, anything - and fix it directly in the code. Commit the change with a clear message explaining what you changed and why. Report what you fixed in 3 lines max."
echo.
pause
