@echo off
REM Runs automatically via Task Scheduler - no pause, logs to file
cd /d "C:\Users\User\ai-trading-dashboard"
set LOGFILE=tasks\logs\daily_%date:~-4,4%%date:~-10,2%%date:~-7,2%.txt
if not exist tasks\logs mkdir tasks\logs

echo ========================================== >> %LOGFILE%
echo  SmartEntry Daily Check - %date% %time% >> %LOGFILE%
echo ========================================== >> %LOGFILE%

claude -p "JARVIS: Daily SmartEntry Pro automated check. 1) Read server/journal.json - last 5 trades with outcome and P&L. 2) Fetch http://localhost:3001/api/signals - all 3 assets: signal, confidence, setup. 3) Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses, halted. 4) Any ACTIONABLE signal with confidence >= 65 must be clearly marked ** SIGNAL READY **. 5) One-line verdict: TRADE TODAY or WAIT. Keep under 25 lines." >> %LOGFILE% 2>&1

REM Show notification in system tray
msg * "SmartEntry: Daily check complete. See tasks\logs\ for report."
