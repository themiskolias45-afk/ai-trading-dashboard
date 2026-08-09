@echo off
REM JARVIS morning cycle. Two things here are deliberate:
REM
REM 1) The agent runs from a CLEAN ROOM, not the project. Inside the project it
REM    loads CLAUDE.md, boots as JARVIS and obeys "one question at a time - then
REM    stop": on 2026-07-25 its entire output was "Want me to build those two
REM    endpoints now?" and tasks\logs\morning_summary.txt was never written.
REM    --add-dir restores project access; --append-system-prompt stops the asking.
REM
REM 2) It PROPOSES, it no longer edits. This previously told an unattended agent to
REM    "implement it in server/index.js, commit with git" - an unreviewed change to
REM    live trading code every morning, which is exactly how a silent regression
REM    reaches a running account. It now writes a proposal for a human to apply.
REM
REM Note: no bare percent signs in the prompt - cmd eats them. Say "percent".
setlocal
REM PROJ comes from this file's own location (%~dp0 is tasks\, so .. is the
REM project root) and AGENTCWD from %LOCALAPPDATA% - never hardcoded. The laptop
REM keeps the project under C:\Users\User and the VPS at C:\ai-trading-dashboard,
REM so a hardcoded path silently breaks on the other box.
for %%I in ("%~dp0..") do set "PROJ=%%~fI"
set "AGENTCWD=%LOCALAPPDATA%\SmartEntryAgentCwd"
set NONINTERACTIVE=You are a non-interactive subprocess in an automated pipeline. There is no human reading your output and no one to answer a question. Never greet, never introduce yourself, never ask for confirmation. Write the file you are asked to write, then stop.

if not exist "%AGENTCWD%" mkdir "%AGENTCWD%"
if not exist "%PROJ%\tasks\logs" mkdir "%PROJ%\tasks\logs"

echo [%date% %time%] JARVIS morning agent starting... >> "%PROJ%\tasks\logs\agent_log.txt"

REM Use the claude.ai subscription, not pay-as-you-go API credit. With
REM ANTHROPIC_API_KEY set the CLI ignores the subscription entirely and bills API
REM credit - on 2026-08-03 that ran out and every agent died in seconds with
REM "Credit balance is too low". Cleared inside setlocal, so only this process.
set "ANTHROPIC_API_KEY="
pushd "%AGENTCWD%"
call claude -p "Run the SmartEntry Pro morning cycle. 1) Fetch http://localhost:3001/api/checksystem and note any problems. 2) Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold as THE gate - never assume a number; if settingsError is not null, report that first because the server is then running on defaults rather than the saved config. 3) Fetch http://localhost:3001/api/signals and list any asset at or above that live gate, with its dataSource. 4) Fetch http://localhost:3001/api/learning and name any setup under 40 percent win rate over 5 or more closed trades; if a setup has fewer than 5 closed trades say so and draw no conclusion from it. 5) Do NOT edit any source file and do NOT commit. If you find a clear low-risk improvement, append it to %PROJ%\tasks\logs\morning_proposals.txt naming the file, the function, the exact change and the evidence for it. 6) Write a one-paragraph summary to %PROJ%\tasks\logs\morning_summary.txt: date, signals found, proposals made, system status. No fluff." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul >> "%PROJ%\tasks\logs\agent_log.txt" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd

echo [%date% %time%] JARVIS morning agent complete (exit %CLAUDE_RC%). >> "%PROJ%\tasks\logs\agent_log.txt"
endlocal & exit /b %CLAUDE_RC%
