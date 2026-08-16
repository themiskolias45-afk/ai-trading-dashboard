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

REM Brief the agent before it works. This VPS job has NEVER read the briefing - it had
REM no way to see what it had already proposed, what was decided, or what is already
REM measured, which is how the same finding got emitted three times across two files.
REM
REM The path lost its backslash when this line was written on 2026-08-14: it read
REM `node tasksai_brief.cjs`, which resolves to nothing, exits non-zero, and dumps
REM "Cannot find module" into %REPORT% while the script carries on. So the fix that was
REM supposed to end the unbriefed runs never ran once itself, and the job stayed exactly
REM as blind as before with a comment above it claiming otherwise. The laptop twin has
REM always been correct (auto_weekly.bat:58). Relative path, matching this file's own
REM style - it cd's to the project root on line 3.
node tasks\ai_brief.cjs --write >> %REPORT% 2>&1

REM "Write to %REPORT%" was an instruction that could never succeed: the >> redirect
REM below holds that handle for the life of this script, so any file write the model
REM attempted was doomed. The 2026-08-09 weekly review flagged this itself and the
REM finding sat unread. Stdout only, exactly as tasks\auto_weekly.bat says.
call claude --dangerously-skip-permissions -p "JARVIS: Weekly SmartEntry Pro review on the VPS. FIRST read tasks/ai_brief.md in full - it lists what you have already proposed, what was decided, what is already measured, and the live config. Do NOT re-raise anything it marks as decided; if your finding matches one, say so in one line and move on. STEP ZERO, before any new analysis: read section 3 of that brief. For every proposal it lists as ungraded, judge whether the DIAGNOSIS held up - not whether the fix was taken, since a proposal can be rejected and still have been right - and emit one line each of the exact form 'SCORED CALL: <id> right|wrong|unproven - <the evidence that settles it>'. Cite a commit, a file:line or a measurement; a grade with no evidence is an opinion with a label. Grade yourself honestly: a wrong call recorded as wrong is worth more than a flattering record. If section 3 says every call is graded, write one line saying so and move on. Do NOT run ai_decide or any other command - a human records these. Then: Read server/journal.json and server/learning.json. Print your review to standard output only - do NOT write, edit or append to any file, they are locked by this script. Cover: 1) Week trade summary - total trades, wins, losses, P&L, win rate. If there are no closed trades say so plainly and state how many more are needed before the learning engine can act (it needs 5 per setup). 2) Best and worst performing asset. 3) One weakness identified from actual results, not speculation. 4) One specific proposed fix marked PROPOSED FIX: naming the function and change. Max 40 lines. Do NOT edit code or commit - propose only." >> %REPORT% 2>&1

REM Completion marker. Without it the ledger cannot tell a run that finished from one
REM that was killed, and every VPS weekly has read "NO COMPLETION MARKER" since the
REM job was created — while the scheduler recorded rc=0 the whole time.
set CLAUDE_RC=%ERRORLEVEL%

REM Same parking as the laptop twin: a closed subscription window costs a delay, not
REM the week's review. claude_agent.py park refuses anything that is not a genuine
REM limit notice, so a real failure still reads as a failure. STDIN, never argv —
REM cmd.exe truncates an argument at the first newline.
if not "%CLAUDE_RC%"=="0" (
  (
    echo Weekly SmartEntry Pro review on the VPS, resumed after a session limit.
    echo Read server/journal.json and server/learning.json. Print to standard output only.
    echo Cover: week trade summary - trades, wins, losses, P&L, win rate; if there are no
    echo closed trades say so plainly and state how many more are needed before the
    echo learning engine can act ^(it needs 5 per setup^); best and worst asset; one
    echo weakness from actual results, not speculation; and one specific proposed fix
    echo marked PROPOSED FIX: naming the function and change. Max 40 lines.
    echo Do NOT edit code and do NOT commit - propose only.
  ) | python claude_agent.py park "Weekly Algo Review" --output-file "%REPORT%" >> %REPORT% 2>&1
  REM A PARKED JOB IS NOT A FAILED JOB. park exits 0 when it queued the brief and 2
  REM when the run was not a limit at all. Without this the .bat propagated claude's
  REM failure code even after parking correctly, so the Task Scheduler showed FAILING
  REM and the doctor showed RED for a job that had handled its own outage. An alert
  REM that cannot clear trains you to skim past the one that matters.
  if not errorlevel 1 set CLAUDE_RC=0
)

echo [exit %CLAUDE_RC%] >> %REPORT%
exit /b %CLAUDE_RC%
