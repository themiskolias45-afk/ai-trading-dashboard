@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
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

REM This run's output goes to its OWN file, then gets appended to agent_log.txt.
REM claude_agent.py park decides by READING the output file, and refuses anything
REM longer than 400 chars so a real answer is never mistaken for a limit notice.
REM agent_log.txt is append-only and already tens of kilobytes, so handing park that
REM file would refuse every limit forever. The per-run capture is what makes parking
REM possible here at all; agent_log.txt still receives exactly what it always did.
set "RUNOUT=%PROJ%\tasks\logs\morning_run_%RANDOM%%RANDOM%.tmp"

pushd "%AGENTCWD%"
call claude -p "FIRST read %PROJ%\tasks\ai_brief.md - prior decisions, open proposals, what is already measured, and the live config. Never re-raise a decided item: section 1 lists proposals already actioned, and four of YOUR OWN are in it (morning_proposals.txt lines 88, 105, 125, 138, all implemented) while that file still says 'still not applied' about them. Reading your own morning_proposals.txt is not enough - it records what you PROPOSED, never what was DECIDED, which is why you re-derived the same fix on 2026-08-07 and again on 2026-08-15. Run the SmartEntry Pro morning cycle. 1) Fetch http://localhost:3001/api/checksystem and note any problems. 2) Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold as THE gate - never assume a number; if settingsError is not null report that first, because the server is then running on defaults rather than the saved config. 3) Fetch http://localhost:3001/api/signals and list any asset at or above that live gate, with its dataSource and updatedAt. If two assets show indicators identical to the previous run while a third moved, say so explicitly - that is a frozen feed, not a flat market. BUT FIRST read barFreshness.spansWeekend for that asset: when it is true the market is simply closed (Gold and SPX do not trade at the weekend, BTC does), which is NOT a frozen feed and must not be reported as one. Only call it frozen when spansWeekend is false and the indicators are genuinely stuck. 4) Fetch http://localhost:3001/api/learning and report setupStats progress toward the 5-closed-trades-per-setup threshold; if a setup has fewer than 5 draw no conclusion from it. 5) Do NOT edit any source file and do NOT commit. If you find a clear low-risk improvement, append it to %PROJ%\tasks\logs\morning_proposals.txt as a block whose FIRST line is the exact literal text PROPOSED FIX: followed by a one-line summary, then the file, the function, the exact change and the evidence on the lines below. That marker is load-bearing, not decoration: server/ai_work_ledger.js harvests proposals by searching for that exact string, so a proposal written without it can never be decided on and you will waste tomorrow re-deriving it. 6) Write a one-paragraph summary to %PROJ%\tasks\logs\morning_summary.txt: date, signals found, learning state, proposals made, system status. No fluff." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul > "%RUNOUT%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd
type "%RUNOUT%" >> "%PROJ%\tasks\logs\agent_log.txt"

REM Park the brief when the subscription window is closed, instead of losing the day.
REM On 2026-08-12 this job died on "You've hit your weekly limit - resets Aug 13, 11am"
REM and simply threw the work away: the weekly review got parking in 6defe8e and this
REM one never did. claude_agent.py park refuses anything that is not a genuine limit
REM notice, so a real failure still surfaces as a failure rather than retrying forever.
REM The brief goes in on STDIN because cmd.exe truncates an argument at the first
REM newline - the single cause of every dead AI job on these machines.
if not "%CLAUDE_RC%"=="0" (
  (
    echo Run the SmartEntry Pro morning cycle, resumed after a subscription limit.
    echo Fetch http://localhost:3001/api/checksystem and note any problems.
    echo Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold
    echo as THE gate, never an assumed number; if settingsError is not null report that
    echo first, because the server is then running on defaults rather than saved config.
    echo Fetch http://localhost:3001/api/signals and list any asset at or above that gate
    echo with its dataSource and updatedAt. If two assets show indicators identical to the
    echo previous run while a third moved, say so - that is a frozen feed, not a flat market. BUT FIRST read barFreshness.spansWeekend for that asset: when it is true the market is simply closed (Gold and SPX do not trade at the weekend, BTC does), which is NOT a frozen feed and must not be reported as one. Only call it frozen when spansWeekend is false and the indicators are genuinely stuck.
    echo Fetch http://localhost:3001/api/learning and report setupStats progress toward the
    echo 5-closed-trades-per-setup threshold; draw no conclusion from a setup under 5.
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
  REM AN EXPIRED LOGIN IS NOT A GENERIC FAILURE. park exits 3 for that case, and
  REM `if not errorlevel 1` is FALSE for 3 - so CLAUDE_RC kept claude's own 1 and the
  REM scheduler recorded "generic failure" for a box whose only problem is that a
  REM human has not signed in. The alarm was right, the reason was wrong, and the
  REM doctor then sent you to read a log instead of naming the one action that fixes
  REM it. Order matters and was verified by running it: a successful `set` clears
  REM ERRORLEVEL to 0, so the 0-case must be tested BEFORE the 3-case.
  if errorlevel 3 set CLAUDE_RC=3
)
del "%RUNOUT%" 2>nul

echo [%date% %time%] JARVIS morning agent complete (exit %CLAUDE_RC%). >> "%PROJ%\tasks\logs\agent_log.txt"

REM Completion marker in the ledger's own format. The human-readable line above says
REM "complete (exit 0)", which exitCodeFrom() in server/ai_work_ledger.js does not
REM match - it looks for the literal [exit N] that every other job here emits. Without
REM this the morning job reads NO COMPLETION MARKER from the moment it is declared,
REM the same false amber tasks\coverage_audit.ps1 carried for its whole life.
echo [exit %CLAUDE_RC%]>> "%PROJ%\tasks\logs\agent_log.txt"
endlocal & exit /b %CLAUDE_RC%
