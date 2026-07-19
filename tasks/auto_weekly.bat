@echo off
REM Runs Sunday 10:00 via Task Scheduler
REM Analyses the week, proposes ONE improvement, saves report, waits for manual approval
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\logs mkdir tasks\logs

set REPORT=tasks\logs\weekly_%date:~-4,4%%date:~-10,2%%date:~-7,2%.txt

echo Weekly Analysis - %date% > %REPORT%
echo ========================================= >> %REPORT%

claude --allowedTools "Read,Write" -p "JARVIS: Weekly SmartEntry Pro review. Read server/journal.json and server/index.js. Write a weekly report to tasks/logs/weekly_%DATE:~-4,4%%DATE:~-10,2%%DATE:~-7,2%.txt containing: 1) Week trade summary: total trades, wins, losses, total P&L, win rate. 2) Best performing asset and worst. 3) Algorithm weakness identified from the results. 4) One specific proposed fix (what function, what change, why). Mark the proposed fix clearly as PROPOSED FIX: so the user can find it and run improve_algo.bat to apply it. Max 40 lines."

msg * "SmartEntry Weekly Report ready. Check tasks\logs\ for the report and proposed improvement."
