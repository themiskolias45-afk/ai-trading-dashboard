@echo off
REM Weekly review — VPS version. Proposes an improvement; does not apply it.
cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs
if exist keys.env (
  for /f "usebackq tokens=1,* delims==" %%a in ("keys.env") do set "%%a=%%b"
)
if exist server\apikey.txt set /p ANTHROPIC_API_KEY=<server\apikey.txt

REM Locale-independent date — see the note in tasks\auto_weekly.bat.
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "TODAY=%%D"
set REPORT=tasks\logs\weekly_%TODAY%.txt
echo Weekly Analysis - %date% > %REPORT%
echo ========================================= >> %REPORT%

claude --dangerously-skip-permissions -p "JARVIS: Weekly SmartEntry Pro review on the VPS. Read server/journal.json and server/learning.json. Write to %REPORT%: 1) Week trade summary - total trades, wins, losses, P&L, win rate. If there are no closed trades say so plainly and state how many more are needed before the learning engine can act (it needs 5 per setup). 2) Best and worst performing asset. 3) One weakness identified from actual results, not speculation. 4) One specific proposed fix marked PROPOSED FIX: naming the function and change. Max 40 lines. Do NOT edit code or commit - propose only." >> %REPORT% 2>&1
