@echo off
REM Runs Sunday 10:00 via Task Scheduler.
REM Analyses the week, proposes ONE improvement, saves report, waits for manual approval.
REM
REM Same clean-room rule as the daily and morning jobs: launched inside the project
REM the agent loads CLAUDE.md, boots as JARVIS and refuses to work unattended. The
REM only weekly report ever produced (26/07, 75 bytes) contains nothing but the two
REM header lines this script echoed - the agent contributed zero bytes.
setlocal
set PROJ=C:\Users\User\ai-trading-dashboard
set AGENTCWD=C:\Users\User\AppData\Local\SmartEntryAgentCwd
set NONINTERACTIVE=You are a non-interactive subprocess in an automated pipeline. There is no human reading your output and no one to answer a question. Never greet, never introduce yourself, never ask for confirmation. Write the file you are asked to write, then stop.

if not exist "%AGENTCWD%" mkdir "%AGENTCWD%"
if not exist "%PROJ%\tasks\logs" mkdir "%PROJ%\tasks\logs"
set REPORT=%PROJ%\tasks\logs\weekly_%date:~-4,4%%date:~-10,2%%date:~-7,2%.txt

echo Weekly Analysis - %date% > "%REPORT%"
echo ========================================= >> "%REPORT%"

pushd "%AGENTCWD%"
claude -p "Weekly SmartEntry Pro review. Read %PROJ%\server\journal.json and consult http://localhost:3001/api/stats/by-setup. Append to %REPORT% : 1) Week trade summary - total trades, wins, losses, total P&L, win rate. 2) Best and worst performing asset. 3) Read avgRealizedR next to avgRR: a setup whose avgRR is high while avgRealizedR is negative is losing money on geometry that only looked good on paper - call that out. 4) One algorithm weakness supported by the trades actually in the journal; if there are too few closed trades to support any conclusion, say exactly that and stop rather than inventing one. 5) One specific proposed fix - which file, which function, what change, what evidence. Mark it clearly as PROPOSED FIX: so it can be found later. Do NOT edit source and do NOT commit. Max 40 lines." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" >> "%REPORT%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd

REM msg.exe fails in a non-interactive session; never let it decide the exit code.
REM That is why this task reported FAILED(1) on 26/07 while its report was written.
msg * "SmartEntry Weekly Report ready. Check tasks\logs\ for the report and proposed improvement." >nul 2>&1

echo [exit %CLAUDE_RC%] >> "%REPORT%"
endlocal & exit /b %CLAUDE_RC%
