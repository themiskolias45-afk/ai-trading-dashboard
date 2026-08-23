@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
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

REM This run's output goes to its OWN file, then gets appended to agent_log.txt.
REM claude_agent.py park decides by READING the output file, and refuses anything
REM longer than 400 chars so a real answer is never mistaken for a limit notice.
REM agent_log.txt is append-only and already tens of kilobytes, so handing park that
REM file would refuse every limit forever. The per-run capture is what makes parking
REM possible here at all; agent_log.txt still receives exactly what it always did.
set "RUNOUT=%PROJ%\tasks\logs\morning_run_%RANDOM%%RANDOM%.tmp"

REM Use the claude.ai subscription, not pay-as-you-go API credit. With
REM ANTHROPIC_API_KEY set the CLI ignores the subscription entirely and bills API
REM credit - on 2026-08-03 that ran out and every agent died in seconds with
REM "Credit balance is too low". Cleared inside setlocal, so only this process.
set "ANTHROPIC_API_KEY="
pushd "%AGENTCWD%"
call claude -p "Run the SmartEntry Pro morning cycle. 1) Fetch http://localhost:3001/api/checksystem and note any problems. 2) Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold as THE gate - never assume a number; if settingsError is not null, report that first because the server is then running on defaults rather than the saved config. 3) Fetch http://localhost:3001/api/signals and list any asset at or above that live gate, with its dataSource. 4) Fetch http://localhost:3001/api/learning and name any setup under 40 percent win rate over 5 or more closed trades; if a setup has fewer than 5 closed trades say so and draw no conclusion from it. 5) Do NOT edit any source file and do NOT commit. If you find a clear low-risk improvement, append it to %PROJ%\tasks\logs\morning_proposals.txt as a block whose FIRST line is the exact literal text PROPOSED FIX: followed by a one-line summary, then the file, the function, the exact change and the evidence for it on the lines below. That marker is load-bearing, not decoration: server/ai_work_ledger.js harvests proposals by searching for that exact string, so a proposal written without it can never be decided on and you will waste tomorrow re-deriving it. 6) Write a one-paragraph summary to %PROJ%\tasks\logs\morning_summary.txt: date, signals found, proposals made, system status. No fluff." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul > "%RUNOUT%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd
type "%RUNOUT%" >> "%PROJ%\tasks\logs\agent_log.txt"

REM Park the brief when the subscription window is closed, instead of losing the day.
REM On 2026-08-12 the VPS twin of this script died on "You've hit your weekly limit -
REM resets Aug 13, 11am" and simply threw the work away: the weekly review got parking
REM in 6defe8e and neither morning agent ever did. claude_agent.py park refuses
REM anything that is not a genuine limit notice, so a real failure still surfaces as a
REM failure rather than retrying forever. The brief goes in on STDIN because cmd.exe
REM truncates an argument at the first newline - the cause of every dead AI job here.
if not "%CLAUDE_RC%"=="0" (
  (
    echo Run the SmartEntry Pro morning cycle, resumed after a subscription limit.
    echo Fetch http://localhost:3001/api/checksystem and note any problems.
    echo Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold
    echo as THE gate, never an assumed number; if settingsError is not null report that
    echo first, because the server is then running on defaults rather than saved config.
    echo Fetch http://localhost:3001/api/signals and list any asset at or above that gate
    echo with its dataSource.
    echo Fetch http://localhost:3001/api/learning and name any setup under 40 percent win
    echo rate over 5 or more closed trades; draw no conclusion from a setup under 5.
    echo Do NOT edit any source file and do NOT commit.
    echo Append any clear low-risk improvement to %PROJ%\tasks\logs\morning_proposals.txt
    echo as a block whose FIRST line is the exact literal text PROPOSED FIX: followed by a
    echo one-line summary, then the file, the function, the exact change and the evidence
    echo below it. server/ai_work_ledger.js harvests proposals by that exact string, so one
    echo written without the marker can never be decided on and gets re-derived tomorrow.
    echo Write a one-paragraph summary to %PROJ%\tasks\logs\morning_summary.txt.
  ) | "%PY%" "%PROJ%\claude_agent.py" park "Morning Agent" --output-file "%RUNOUT%" >> "%PROJ%\tasks\logs\agent_log.txt" 2>&1
  REM A PARKED JOB IS NOT A FAILED JOB. park exits 0 when it queued the brief and 2
  REM when the run was not a limit at all. Without this the .bat propagated claude's
  REM failure code even after parking correctly, so the Task Scheduler showed FAILING
  REM and the doctor showed RED for a job that had handled its own outage. An alert
  REM that cannot clear trains you to skim past the one that matters.
  if not errorlevel 1 set CLAUDE_RC=0
)
del "%RUNOUT%" 2>nul

echo [%date% %time%] JARVIS morning agent complete (exit %CLAUDE_RC%). >> "%PROJ%\tasks\logs\agent_log.txt"

REM Completion marker in the ledger's own format. The human-readable line above says
REM "complete (exit 0)", which exitCodeFrom() in server/ai_work_ledger.js does not
REM match - it looks for the literal [exit N] that every other job here emits. Without
REM this the morning job would read NO COMPLETION MARKER from the moment it was
REM declared, which is the exact false amber tasks\coverage_audit.ps1 carried for its
REM whole life. Same bug, same shape: a writer and a reader disagreeing on a contract.
echo [exit %CLAUDE_RC%]>> "%PROJ%\tasks\logs\agent_log.txt"
endlocal & exit /b %CLAUDE_RC%
