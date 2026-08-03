@echo off
REM JARVIS autonomous morning cycle - VPS.
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

echo [%date% %time%] JARVIS morning agent starting... >> "%PROJ%\tasks\logs\agent_log.txt"

pushd "%AGENTCWD%"
claude -p "Run the SmartEntry Pro morning cycle. 1) Fetch http://localhost:3001/api/checksystem and note any problems. 2) Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold as THE gate - never assume a number; if settingsError is not null report that first, because the server is then running on defaults rather than the saved config. 3) Fetch http://localhost:3001/api/signals and list any asset at or above that live gate, with its dataSource and updatedAt. If two assets show indicators identical to the previous run while a third moved, say so explicitly - that is a frozen feed, not a flat market. 4) Fetch http://localhost:3001/api/learning and report setupStats progress toward the 5-closed-trades-per-setup threshold; if a setup has fewer than 5 draw no conclusion from it. 5) Do NOT edit any source file and do NOT commit. If you find a clear low-risk improvement, append it to %PROJ%\tasks\logs\morning_proposals.txt naming the file, the function, the exact change and the evidence. 6) Write a one-paragraph summary to %PROJ%\tasks\logs\morning_summary.txt: date, signals found, learning state, proposals made, system status. No fluff." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul >> "%PROJ%\tasks\logs\agent_log.txt" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd

echo [%date% %time%] JARVIS morning agent complete (exit %CLAUDE_RC%). >> "%PROJ%\tasks\logs\agent_log.txt"
endlocal & exit /b %CLAUDE_RC%
