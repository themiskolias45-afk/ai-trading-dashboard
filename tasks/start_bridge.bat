@echo off
title SmartEntry MT5 Bridge - AUTO MODE
cd /d C:\Users\User\ai-trading-dashboard
echo.
echo  SmartEntry MT5 Bridge - FULL AUTO MODE
echo  STRONG signals execute instantly. Semi-auto for MODERATE.
echo  Risk: 1%% per trade. Circuit breaker: 3 consecutive losses.
echo  Press Ctrl+C to stop.
echo.
REM This script used to run `python mt5_bridge.py --auto` with no ACCOUNT_TAG. That
REM bridge auto-detects whichever MT5 terminal answers first, reports to the server
REM as account "default", and keeps its own circuit-breaker counter — so it can open
REM every qualifying signal a SECOND time on an account a tagged bridge already owns,
REM and the two counters each see half the losses. It refuses rather than guesses.
echo  REFUSING to start an untagged bridge.
echo.
echo  An untagged bridge auto-detects a terminal and can double a tagged account's
echo  positions. Start the one you actually want:
echo.
echo     tasks\start_bridge_A.bat     account 25446287  (Program Files terminal)
echo     tasks\start_bridge_B.bat     account 11581419  (AppData terminal)
echo.
echo  Semi-auto: set BRIDGE_MODE=SEMI first, then run the same script.
echo.
pause
exit /b 1
