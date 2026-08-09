@echo off
REM Runs automatically via Task Scheduler - no pause, logs to file
REM
REM The claude call runs from a CLEAN ROOM, not from the project directory.
REM Launched inside the project it loads CLAUDE.md, boots as JARVIS, obeys
REM "one question at a time - then stop", asks something, hits EOF on closed
REM stdin and exits having written nothing. Measured 2026-08-03: the morning
REM agent's entire output was "Want me to build those two endpoints now?" and
REM its summary file was never created. --add-dir gives the clean-room agent
REM read/write access back to the project; --append-system-prompt is what
REM actually stops it greeting and asking.
setlocal
REM PROJ comes from this file's own location (%~dp0 is tasks\, so .. is the
REM project root) and AGENTCWD from %LOCALAPPDATA% - never hardcoded. The laptop
REM keeps the project under C:\Users\User and the VPS at C:\ai-trading-dashboard,
REM so a hardcoded path silently breaks on the other box.
for %%I in ("%~dp0..") do set "PROJ=%%~fI"
set "AGENTCWD=%LOCALAPPDATA%\SmartEntryAgentCwd"
set NONINTERACTIVE=You are a non-interactive subprocess in an automated pipeline. There is no human reading your output and no one to answer a question. Never greet, never introduce yourself, never ask for confirmation. Do the work and report, then stop.

if not exist "%AGENTCWD%" mkdir "%AGENTCWD%"
if not exist "%PROJ%\tasks\logs" mkdir "%PROJ%\tasks\logs"
REM Locale-independent date — see the note in tasks\auto_weekly.bat. Slicing %date%
REM lands on MM,DD on the VPS ("Fri 08/07/2026") and DD,MM on this laptop
REM ("07/08/2026"), so every filename here had day and month transposed.
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "TODAY=%%D"
set LOGFILE=%PROJ%\tasks\logs\daily_%TODAY%.txt

echo ========================================== >> "%LOGFILE%"
echo  SmartEntry Daily Check - %date% %time% >> "%LOGFILE%"
echo ========================================== >> "%LOGFILE%"

REM ── Compound the free evidence, before the agent reads anything ───────────────
REM The rejection ledger is the only source of outcome data that grows without
REM risking money, and the binding constraint on this system is sample size. Scoring
REM it by hand "weekly" meant it was scored once. These two steps are deterministic -
REM no AI, no network - and are run BEFORE the agent so its report reflects today's
REM evidence rather than whenever someone last remembered.
REM
REM Their exit codes are deliberately NOT captured: CLAUDE_RC below is the task's
REM result, and a thin ledger returning nothing to score is a normal early state, not
REM a failed daily check.
echo. >> "%LOGFILE%"
echo --- rejection ledger --- >> "%LOGFILE%"
python "%PROJ%\tasks\score_rr_rejections.py" >> "%LOGFILE%" 2>&1
python "%PROJ%\tasks\learning_from_rejections.py" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM The confidence gate is NOT hardcoded here. It moved 65 -> 70 on 2026-08-02 and
REM this file was still asking about 65, so it would have flagged sub-gate signals
REM as ready. The agent reads the live value instead.
REM Use the claude.ai subscription, not pay-as-you-go API credit. With
REM ANTHROPIC_API_KEY set the CLI ignores the subscription entirely and bills API
REM credit - on 2026-08-03 that ran out and every agent died in seconds with
REM "Credit balance is too low". Cleared inside setlocal, so only this process.
set "ANTHROPIC_API_KEY="
pushd "%AGENTCWD%"
REM CALL, not a bare invocation. `claude` resolves to claude.cmd, and running a
REM .CMD from a .BAT without CALL transfers control and never comes back — every
REM line below this one was dead. No [exit N] marker has ever been written to any
REM log in this project, the completion notification never fired, and endlocal
REM never ran. Found 2026-08-09 by the AI work ledger looking for the marker.
call claude -p "Daily SmartEntry Pro automated check. 1) Read %PROJ%\server\journal.json - last 5 trades with outcome and P&L. 2) Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold as THE gate - never assume a number. If settingsError is not null, say so first: the server is on built-in defaults, not the saved config. 3) Fetch http://localhost:3001/api/signals - all 3 assets: signal, confidence, setup, dataSource. 4) Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses, halted. 5) Any signal at or above the live gate must be marked ** SIGNAL READY **. 6) Read %PROJ%\server\learning_shadow.json if it exists - per-setup evidence from REJECTED setups walked forward on real bars. These are paper results with no slippage, and they do NOT feed the live gate. Name any setup whose enoughForReading is true and say what its rPerEpisode implies. If the file is absent or every setup is still insufficient, say exactly that. 7) One-line verdict: TRADE TODAY or WAIT. Keep under 30 lines." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul >> "%LOGFILE%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd

REM Notify, but never let the notifier decide this task's exit code - msg.exe
REM fails in a non-interactive session and would report a healthy run as failed.
msg * "SmartEntry: Daily check complete. See tasks\logs\ for report." >nul 2>&1

echo [exit %CLAUDE_RC%] >> "%LOGFILE%"
endlocal & exit /b %CLAUDE_RC%
