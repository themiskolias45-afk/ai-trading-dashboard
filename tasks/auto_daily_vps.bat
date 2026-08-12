@echo off
REM Daily SmartEntry check - VPS. Headless: no msg popup.
REM
REM Machine-agnostic by construction: PROJ is derived from this file's own location
REM (%~dp0 is tasks\, so .. is the project root), never hardcoded. The laptop keeps
REM the project at C:\Users\User\ai-trading-dashboard and the VPS at
REM C:\ai-trading-dashboard, so a hardcoded path silently breaks on the other box.
REM AGENTCWD likewise comes from %LOCALAPPDATA% - the VPS runs as Administrator.
REM
REM The claude call runs from a CLEAN ROOM, not the project directory. Launched
REM inside the project it loads CLAUDE.md, boots as JARVIS and obeys "one question
REM at a time - then stop". The VPS log shows exactly that: a run ending with
REM "Which do you want me to chase first?" instead of writing its output.
REM --add-dir restores project access; --append-system-prompt stops the asking.
REM
REM ANTHROPIC_API_KEY is CLEARED, not set. These scripts used to load it from
REM server\apikey.txt on the reasoning that a Scheduled Task inherits no
REM environment - but with the key set the CLI ignores the claude.ai subscription
REM and bills pay-as-you-go API credit. On 2026-08-03 that credit ran out and both
REM VPS agents failed with "Credit balance is too low". The subscription login is
REM what these should use.
setlocal
for %%I in ("%~dp0..") do set "PROJ=%%~fI"
set "AGENTCWD=%LOCALAPPDATA%\SmartEntryAgentCwd"
set "ANTHROPIC_API_KEY="
set "NONINTERACTIVE=You are a non-interactive subprocess in an automated pipeline. There is no human reading your output and no one to answer a question. Never greet, never introduce yourself, never ask for confirmation. Do the work and report, then stop."

if not exist "%AGENTCWD%" mkdir "%AGENTCWD%"
if not exist "%PROJ%\tasks\logs" mkdir "%PROJ%\tasks\logs"

REM Locale-independent date — see the note in tasks\auto_weekly.bat. Correct on this
REM box today only because the VPS locale happens to be US with a weekday prefix;
REM pinning it removes the dependency rather than relying on that staying true.
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "TODAY=%%D"
set "LOGFILE=%PROJ%\tasks\logs\daily_%TODAY%.txt"
REM The claude call writes HERE first, then gets appended to LOGFILE. park decides by
REM READING the file it is given and refuses anything over 400 chars, so handing it
REM LOGFILE would never park: by then LOGFILE already holds the rejection-scoring and
REM shadow-learning output. LOGFILE still receives exactly what it always did.
set "RUNOUT=%PROJ%\tasks\logs\daily_run_%RANDOM%%RANDOM%.tmp"
echo ========================================== >> "%LOGFILE%"
echo  SmartEntry Daily Check - %date% %time% >> "%LOGFILE%"
echo ========================================== >> "%LOGFILE%"

REM ── Compound the free evidence, before the agent reads anything ───────────────
REM Same reasoning as tasks\auto_daily.bat: the rejection ledger is the only source
REM of outcome data that grows without risking money, and sample size is the binding
REM constraint. Deterministic, no AI, and their exit codes are deliberately not
REM captured -- a thin ledger is a normal early state, not a failed daily check.
echo. >> "%LOGFILE%"
echo --- rejection ledger --- >> "%LOGFILE%"
python "%PROJ%\tasks\score_rr_rejections.py" >> "%LOGFILE%" 2>&1
python "%PROJ%\tasks\learning_from_rejections.py" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

pushd "%AGENTCWD%"
call claude -p "Daily SmartEntry Pro automated check. 1) Read %PROJ%\server\journal.json if it exists - last 5 trades with outcome and P&L; if absent say 'no trades yet'. 2) Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold as THE gate - never assume a number. If settingsError is not null say so first: the server is on built-in defaults, not the saved config. 3) Fetch http://localhost:3001/api/signals - all 3 assets: signal, confidence, setup, dataSource, updatedAt. Call out any asset whose indicators are unchanged from the previous check while another asset moved - that is a frozen feed. 4) Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses, halted. 5) Fetch http://localhost:3001/api/learning - setupStats progress toward the 5-trades-per-setup threshold. 6) Any signal at or above the live gate must be marked ** SIGNAL READY **. 7) One-line verdict: TRADE TODAY or WAIT. Under 25 lines. Report only, do not edit code." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul > "%RUNOUT%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd
type "%RUNOUT%" >> "%LOGFILE%"

REM Park the brief when the subscription window is closed, instead of losing the day.
REM On 2026-08-12 the morning agent on this box died on "You have hit your weekly limit
REM - resets Aug 13, 11am" and threw its work away. A weekly ceiling kills every claude
REM job here at once, so this one would have gone the same way. park refuses anything
REM that is not a genuine limit notice, so a real failure still surfaces as a failure.
REM The brief goes in on STDIN because cmd.exe truncates an argument at the first newline.
if not "%CLAUDE_RC%"=="0" (
  (
    echo Daily SmartEntry Pro automated check, resumed after a subscription limit.
    echo Read %PROJ%\server\journal.json if it exists - last 5 trades with outcome and P&L.
    echo Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold
    echo as THE gate, never an assumed number. If settingsError is not null say so first:
    echo the server is then on built-in defaults, not the saved config.
    echo Fetch http://localhost:3001/api/signals - all 3 assets: signal, confidence, setup,
    echo dataSource, updatedAt. Call out any asset whose indicators are unchanged while
    echo another moved - that is a frozen feed. Mark any signal at or above the gate
    echo SIGNAL READY.
    echo Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses, halted.
    echo Fetch http://localhost:3001/api/learning - setupStats progress toward the
    echo 5-trades-per-setup threshold.
    echo End with a one-line verdict: TRADE TODAY or WAIT. Under 25 lines, report only.
  ) | python "%PROJ%\claude_agent.py" park "Daily Check" --output-file "%RUNOUT%" >> "%LOGFILE%" 2>&1
)
del "%RUNOUT%" 2>nul

echo [exit %CLAUDE_RC%] >> "%LOGFILE%"
endlocal & exit /b %CLAUDE_RC%
