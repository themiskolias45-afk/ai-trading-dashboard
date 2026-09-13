@echo off
REM ============================================================================
REM  GENERIC AGENT RUNNER --  run_agent.bat <agent-name>
REM ============================================================================
REM  Runs one agent from .claude\agents\<name>.md on a schedule, unattended.
REM
REM  WHY THIS EXISTS. Until 2026-09-08 exactly ONE of the seven agent definitions
REM  ever ran on its own: morning_agent.bat. analyst, researcher, tester,
REM  code-reviewer, builder and medic existed as briefs and were only reachable if
REM  a human opened a session and asked for them. Seven definitions, one runner.
REM
REM  EVERY HARD-WON DETAIL BELOW IS COPIED FROM morning_agent.bat DELIBERATELY.
REM  Each line is a bug that already happened once:
REM
REM   1. CLEAN ROOM CWD. Run inside the project and the agent loads CLAUDE.md,
REM      boots as JARVIS and obeys "one question at a time - then stop". On
REM      2026-07-25 the morning agent's ENTIRE output was "Want me to build those
REM      two endpoints now?" and its summary file was never written. --add-dir
REM      gives back project access without the persona.
REM   2. --append-system-prompt NONINTERACTIVE. Same defect from the other side:
REM      nobody is reading, so a question is a silent failure.
REM   3. ANTHROPIC_API_KEY cleared. Use the claude.ai subscription, never
REM      pay-as-you-go credit.
REM   4. <nul on stdin. A run that inherits a console handle can block forever.
REM   5. claude_agent.py park. A subscription limit is a PAUSE, not a failure:
REM      the full brief is parked and SmartEntryAgentDrain resumes it later.
REM      Without this a limited run destroyed the job and the next run rebuilt it
REM      from nothing.
REM   6. resolve_python.bat. Bare `python` follows PATH, and on 2026-08-23 PATH
REM      pointed at a uv trampoline Smart App Control had started blocking -
REM      every python call on the box died at once for 8h32m.
REM
REM  IT NEVER COMMITS AND NEVER EDITS. The prompt forbids both, and the three
REM  read-only agents are additionally restricted at the tools: line in their own
REM  definition (ee2b985), so the instruction is not the only thing holding.
REM  That matters: an agent once ran 217 calls past its brief, made 6 commits,
REM  installed scheduled tasks on BOTH boxes and reversed a LOCKED decision.
REM  Prose alone did not stop it; the tools line does.
REM ============================================================================

setlocal EnableDelayedExpansion

if "%~1"=="" (
  echo usage: run_agent.bat ^<agent-name^>
  echo   e.g. run_agent.bat tester
  exit /b 2
)

set "AGENT=%~1"
set "PROJ=%~dp0.."
for %%I in ("%PROJ%") do set "PROJ=%%~fI"
set "DEF=%PROJ%\.claude\agents\%AGENT%.md"

if not exist "%DEF%" (
  echo run_agent: no such agent definition: %DEF%
  exit /b 2
)

call "%~dp0resolve_python.bat"

REM Clean room: outside the project so CLAUDE.md does not load.
set "AGENTCWD=%LOCALAPPDATA%\SmartEntryAgentCwd"
if not exist "%AGENTCWD%" mkdir "%AGENTCWD%"

set "LOG=%PROJ%\tasks\logs\agent_%AGENT%.txt"
set "RUNOUT=%PROJ%\tasks\logs\agent_%AGENT%_run_%RANDOM%%RANDOM%.tmp"

REM ── ONE RUN PER AGENT AT A TIME ──────────────────────────────────────────────
REM
REM TWO THINGS RUN AGENTS and neither knew about the other: this script, fired by
REM the agent's own scheduled task, and tasks\drain_agents.bat, which RESUMES a
REM brief that parked on a subscription limit. They collide.
REM
REM Measured 2026-09-13. At 13:42 code-reviewer parked - "the session limit was hit;
REM the next drain resumes it". At 17:54:10 the scheduled task AND the drain both
REM fired as missed-run CATCH-UPS (68 of 70 tasks on this box are StartWhenAvailable,
REM so a sleeping laptop wakes to a thundering herd - five tasks started in that one
REM second). Both then ran code-reviewer. One died after 35s with
REM STATUS_CONTROL_C_EXIT (0xC000013A) having written NOTHING - an empty log block
REM under a header, which reads as "the agent is broken" rather than "it was run twice".
REM Run alone, the identical command completes rc=0 with a full report.
REM
REM mkdir is ATOMIC on Windows - it succeeds for exactly one caller - which is why the
REM lock is a directory and not a file. A file test-then-create has a race between the
REM test and the create, which is the bug being fixed, not a fix for it.
set "AGENTLOCK=%PROJ%\tasks\logs\.agentlock_%AGENT%"

REM A lock older than the task's own ExecutionTimeLimit (PT1H) belongs to a run that
REM cannot still be alive - a killed process never reached its cleanup. Take it over,
REM so a single hard kill cannot disable this agent forever. 90 minutes, not 60, so a
REM run that is merely slow is never robbed of its lock mid-flight.
if exist "%AGENTLOCK%" (
  for /f %%S in ('powershell -NoProfile -Command ^
    "$d=Get-Item -LiteralPath '%AGENTLOCK%' -ErrorAction SilentlyContinue; if($d -and ((Get-Date)-$d.CreationTime).TotalMinutes -gt 90){'STALE'}else{'FRESH'}"') do set "LOCKAGE=%%S"
  if "!LOCKAGE!"=="STALE" (
    echo [%DATE% %TIME%] %AGENT%: taking over a stale lock ^(older than 90 min^) >> "%LOG%"
    rmdir "%AGENTLOCK%" 2>nul
  )
)

mkdir "%AGENTLOCK%" 2>nul
if errorlevel 1 (
  REM EXIT 0, DELIBERATELY. The other run is doing the work, so this is not a failure
  REM and must not paint the health board red - a false RED here trains the reader to
  REM ignore the board, which is how a real one gets missed.
  echo. >> "%LOG%"
  echo [%DATE% %TIME%] %AGENT%: another run holds the lock - skipping this one, not a failure >> "%LOG%"
  endlocal ^& exit /b 0
)

set NONINTERACTIVE=You are a non-interactive subprocess in an automated pipeline. There is no human reading your output and no one to answer a question. Never greet, never introduce yourself, never ask for confirmation. Do the work described, write your findings, then stop.

REM Subscription, not API credit.
set "ANTHROPIC_API_KEY="

echo. >> "%LOG%"
echo ========== %DATE% %TIME%  agent=%AGENT% ========== >> "%LOG%"

pushd "%AGENTCWD%"
call claude -p "You are the '%AGENT%' agent for SmartEntry Pro. Your full brief is the file %DEF% - READ IT FIRST and follow it exactly, including everything it forbids. Work on the repository at %PROJ%. HARD RULES for this run, which override anything in the brief that sounds permissive: do NOT edit, create or delete any source file; do NOT run git commit, git push, git reset or git checkout; do NOT install, register or modify any scheduled task; do NOT place, size or close a trade. You are producing a REPORT, not a change. Write your findings to %PROJ%\tasks\logs\agent_%AGENT%_report.md, overwriting it, with the date on the first line. If you find something worth changing, describe it there with the file, the exact change and the evidence - do not apply it. Be specific and short; every claim must name the file or command you verified it from." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul > "%RUNOUT%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd

type "%RUNOUT%" >> "%LOG%"

REM A subscription ceiling is a pause. Park the brief so the drain can resume it.
set "BRIEF=%PROJ%\tasks\logs\park_brief_%AGENT%_%RANDOM%%RANDOM%.tmp"
echo Run the '%AGENT%' agent per %DEF%. Report only, no edits, no commits. Write to %PROJ%\tasks\logs\agent_%AGENT%_report.md > "%BRIEF%"
"%PY%" "%PROJ%\claude_agent.py" park "%AGENT% Agent" --output-file "%RUNOUT%" < "%BRIEF%" >> "%PROJ%\tasks\logs\agent_log.txt" 2>&1
set PARK_RC=%ERRORLEVEL%
del "%BRIEF%" 2>nul

REM PARK_RC 0 means the run WAS parked as limited - that is a pause, report success
REM so the scheduler does not flag a failure for something that will be resumed.
if "%PARK_RC%"=="0" (
  echo [%DATE% %TIME%] %AGENT%: parked on a subscription limit, drain will resume >> "%LOG%"
  del "%RUNOUT%" 2>nul
  endlocal & exit /b 0
)

del "%RUNOUT%" 2>nul
echo [%DATE% %TIME%] %AGENT%: finished rc=%CLAUDE_RC% >> "%LOG%"
endlocal & exit /b %CLAUDE_RC%
