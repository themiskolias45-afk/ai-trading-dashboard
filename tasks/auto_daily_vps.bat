@echo off
REM Daily SmartEntry check — VPS version. Was local-only, so it ran only when the
REM home PC happened to be on. No msg popup: this box is headless.
cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs
if exist keys.env (
  for /f "usebackq tokens=1,* delims==" %%a in ("keys.env") do set "%%a=%%b"
)
if exist server\apikey.txt set /p ANTHROPIC_API_KEY=<server\apikey.txt

set LOGFILE=tasks\logs\daily_%date:~-4,4%%date:~-10,2%%date:~-7,2%.txt
echo ========================================== >> %LOGFILE%
echo  SmartEntry Daily Check - %date% %time% >> %LOGFILE%
echo ========================================== >> %LOGFILE%

claude --dangerously-skip-permissions -p "JARVIS: Daily SmartEntry Pro automated check on the VPS. 1) Read server/journal.json if it exists - last 5 trades with outcome and P&L; if absent say 'no trades yet'. 2) Fetch http://localhost:3001/api/signals - all 3 assets: signal, confidence, setup, strength. 3) Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses, halted. 4) Fetch http://localhost:3001/api/learning - setupStats progress toward the 5-trades-per-setup threshold. 5) Any ACTIONABLE signal with confidence >= 65 must be marked ** SIGNAL READY **. 6) One-line verdict: TRADE TODAY or WAIT. Under 25 lines. Report only, do not edit code." >> %LOGFILE% 2>&1
