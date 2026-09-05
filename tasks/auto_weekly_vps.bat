@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
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

REM Calibration officer, added 2026-08-28. Runs BEFORE the agent so its review reads
REM today's calibration rather than re-deriving it. Confidence is the number every gate
REM trusts and nothing had ever checked whether it is TRUE: the replay shows SP500 firing
REM only at ~86 - the HIGHEST-confidence cohort - and losing 36 of 39 with 21 consecutive
REM losses. The live learning engine structurally cannot see it (floor is 5 closed trades
REM per setup; SPX has one).
REM
REM Read-only: no gate, threshold, confidence or sizing is touched, feedsTheGate is false,
REM and live vs replay are reported SEPARATELY and never merged. Exit code deliberately
REM NOT captured, like every other scorer here - a thin journal is a normal early state,
REM not a failed weekly review. --replay adds ~90s and is the whole point of running it
REM weekly rather than daily.
node "%PROJ%\tasks\calibration_officer.cjs" --replay --emit >> "%REPORT%" 2>&1

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
REM The brief is written to a FILE and redirected in, never piped from a nested
REM ( ) block. Measured on the VPS 2026-09-05: `( echo... ) | prog` delivers ZERO
REM bytes of stdin when it sits inside an enclosing `if ( ... )` block, while the
REM identical pipe outside one delivers correctly -- 0 bytes against 317. So park
REM had NEVER received a brief on either box, in any job: it printed "park: nothing
REM on stdin -- a brief with no prompt cannot be resumed" and exited 1 every time.
REM The safety net that exists to save a day's work at the subscription ceiling was
REM discarding the very thing it was meant to save.
REM
REM BRIEF is declared HERE, outside the block, deliberately: cmd expands a whole
REM parenthesised block at parse time, so setting it and using it inside one block
REM would read the value from before the set. %RANDOM% is expanded once for the
REM same reason, which is what makes every line below agree on one filename.
set "BRIEF=%PROJ%\tasks\logs\park_brief_%RANDOM%%RANDOM%.tmp"
if not "%CLAUDE_RC%"=="0" (
  > "%BRIEF%" echo Weekly SmartEntry Pro review on the VPS, resumed after a session limit.
  >> "%BRIEF%" echo Read server/journal.json and server/learning.json. Print to standard output only.
  >> "%BRIEF%" echo Cover: week trade summary - trades, wins, losses, P&L, win rate; if there are no
  >> "%BRIEF%" echo closed trades say so plainly and state how many more are needed before the
  >> "%BRIEF%" echo learning engine can act ^(it needs 5 per setup^); best and worst asset; one
  >> "%BRIEF%" echo weakness from actual results, not speculation; and one specific proposed fix
  >> "%BRIEF%" echo marked PROPOSED FIX: naming the function and change. Max 40 lines.
  >> "%BRIEF%" echo Do NOT edit code and do NOT commit - propose only.
  "%PY%" claude_agent.py park "Weekly Algo Review" --output-file "%REPORT%" >> %REPORT% 2>&1 < "%BRIEF%"
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
del "%BRIEF%" 2>nul

echo [exit %CLAUDE_RC%] >> %REPORT%

REM Re-index the weekly reports so /dashboard/weekly.html shows this run. The page
REM reads dashboard\weekly-latest.json, a static file express.static already serves,
REM so no route and no server restart were needed - which makes THIS line the thing
REM that actually publishes a new review. The index is generated per box: this one
REM has its own weekly_*.txt and must not be handed the laptop copy.
REM
REM After the exit marker and never allowed to change the exit code: indexing is a
REM reporting step, and a failed index must not turn a successful review - or a
REM correctly PARKED one - into a failed scheduled task.
node tasks\weekly_report_index.cjs --quiet >> %REPORT% 2>&1

exit /b %CLAUDE_RC%
