@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
REM Runs Sunday 10:00 via Task Scheduler.
REM Analyses the week, proposes ONE improvement, saves report, waits for manual approval.
REM
REM Same clean-room rule as the daily and morning jobs: launched inside the project
REM the agent loads CLAUDE.md, boots as JARVIS and refuses to work unattended. The
REM only weekly report ever produced (26/07, 75 bytes) contains nothing but the two
REM header lines this script echoed - the agent contributed zero bytes.
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
REM Date from PowerShell, not from slicing %date%.
REM
REM %date% is LOCALE-dependent and the two boxes disagree. The VPS gives
REM "Fri 08/07/2026" (US, with a weekday prefix) where the old slices
REM %date:~-10,2%%date:~-7,2% land on MM then DD and are correct. This laptop gives
REM "07/08/2026" (UK, no prefix) where the same slices land on DD then MM, so every
REM filename came out with day and month transposed: the report written on 7 August
REM was named weekly_20260708 and reads as 8 July. Worse on two-digit days -
REM weekly_20262607 (26 July) and daily_20262107 (21 July) carry month "26" and "21"
REM and no date parser will take them. The Python-written daily_runner_* files next
REM to them are correct, which is what makes the .bat ones obviously wrong.
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "TODAY=%%D"
set REPORT=%PROJ%\tasks\logs\weekly_%TODAY%.txt

echo Weekly Analysis - %date% > "%REPORT%"
echo ========================================= >> "%REPORT%"

REM Use the claude.ai subscription, not pay-as-you-go API credit. With
REM ANTHROPIC_API_KEY set the CLI ignores the subscription entirely and bills API
REM credit - on 2026-08-03 that ran out and every agent died in seconds with
REM "Credit balance is too low". Cleared inside setlocal, so only this process.
set "ANTHROPIC_API_KEY="
pushd "%AGENTCWD%"
REM The prompt must NOT name %REPORT% as a file to write.
REM
REM This line redirects stdout into %REPORT% with >>, so cmd holds that file open for
REM the entire run. Asking the agent to "Append to %REPORT%" therefore asked it to
REM write to a file its own launcher had locked. On 2026-08-07 it spent ~20s and six
REM retries on Edit, Add-Content and bash >> before giving up and writing the review
REM to weekly_20260807_review.txt instead -- the analysis was fine, the delivery was
REM impossible. The redirect below is the whole delivery mechanism; the agent just
REM has to print.
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

REM Brief the agent before it works. On 2026-08-09 this review proposed a fix to
REM /api/trade-opened that was ALREADY IMPLEMENTED, more thoroughly than it asked
REM for -- sound reasoning, code-cited, and wasted, because it had no way to see
REM what it had proposed before or what was decided. It also emitted the same
REM finding three times across two files. The brief carries prior decisions, open
REM proposals, what is already measured, and the live config.
node "%PROJ%\tasks\ai_brief.cjs" --write >> "%REPORT%" 2>&1

REM CALL, not a bare invocation — see the same fix in auto_daily.bat. `claude` is
REM claude.cmd, and a .CMD run from a .BAT without CALL never returns, so every
REM line after this was dead: no [exit N] marker, no cleanup, no exit code of our
REM own. The scheduled task's result came from claude.cmd by accident, not design.
REM Section 3 of the brief lists proposals that were ACTED ON but whose diagnosis was
REM never graded. That field has existed since the ledger was built and went unused for
REM every proposal ever made, because grading depended on a human remembering an
REM optional --call flag and nothing ever showed the gap. An agent that is never told
REM whether it was right cannot improve, and raising its output rate without that
REM signal only manufactures unread work. It GRADES, it does not record: the SCORED
REM CALL lines land in this report and a human commits them with ai_decide --call, so
REM the employee never writes its own appraisal.
call claude -p "FIRST read %PROJ%\tasks\ai_brief.md in full - it lists what you have already proposed, what was decided, what is already measured, and the live config. Do NOT re-raise anything it marks as decided; if your finding matches one, say so in one line and move on. STEP ZERO, before any new analysis: read section 3 of that brief. For every proposal it lists as ungraded, judge whether the DIAGNOSIS held up - not whether the fix was taken, since a proposal can be rejected and still have been right - and emit one line each of the exact form 'SCORED CALL: <id> right|wrong|unproven - <the evidence that settles it>'. Cite a commit, a file:line or a measurement; a grade with no evidence is an opinion with a label. Grade yourself honestly: a wrong call recorded as wrong is worth more than a flattering record, because the point is to find out where your reasoning fails. If section 3 says every call is graded, write one line saying so and move on. Do NOT run ai_decide or any other command - a human records these. Then: weekly SmartEntry Pro review. Read %PROJ%\server\journal.json and consult http://localhost:3001/api/stats/by-setup. Print your review to standard output only - do NOT write, edit or append to any file, they are locked by this script. Cover: 1) Week trade summary - total trades, wins, losses, total P&L, win rate. 2) Best and worst performing asset. 3) Read avgRealizedR next to avgRR: a setup whose avgRR is high while avgRealizedR is negative is losing money on geometry that only looked good on paper - call that out. 4) One algorithm weakness supported by the trades actually in the journal; if there are too few closed trades to support any conclusion, say exactly that and stop rather than inventing one. 5) One specific proposed fix - which file, which function, what change, what evidence. Mark it clearly as PROPOSED FIX: so it can be found later. Do NOT edit source and do NOT commit. Max 40 lines." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul >> "%REPORT%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd

REM msg.exe fails in a non-interactive session; never let it decide the exit code.
REM That is why this task reported FAILED(1) on 26/07 while its report was written.
msg * "SmartEntry Weekly Report ready. Check tasks\logs\ for the report and proposed improvement." >nul 2>&1

REM Park the brief when the subscription window closed, instead of losing the week.
REM On 2026-08-09 this job wrote a 136-byte "You've hit your session limit" stub and
REM exited 1, and the work was simply gone until someone noticed — which nothing did.
REM claude_agent.py park refuses anything that is not a genuine limit notice, so a
REM real failure still surfaces as a failure instead of retrying forever. The brief
REM goes in on STDIN because cmd.exe truncates an argument at the first newline.
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
  > "%BRIEF%" echo Weekly SmartEntry Pro review, resumed after a session limit.
  >> "%BRIEF%" echo FIRST read %PROJ%\tasks\ai_brief.md in full - do NOT re-raise anything it marks as decided.
  >> "%BRIEF%" echo Read %PROJ%\server\journal.json and consult http://localhost:3001/api/stats/by-setup.
  >> "%BRIEF%" echo Print to standard output only. Cover: week trade summary; best and worst asset;
  >> "%BRIEF%" echo avgRealizedR next to avgRR - a setup with high avgRR and negative avgRealizedR is
  >> "%BRIEF%" echo losing money on geometry that only looked good on paper; one algorithm weakness
  >> "%BRIEF%" echo supported by trades actually in the journal, or say plainly there are too few;
  >> "%BRIEF%" echo and one specific proposed fix marked PROPOSED FIX: naming file, function and evidence.
  >> "%BRIEF%" echo Do NOT edit source and do NOT commit. Max 40 lines.
  "%PY%" "%PROJ%\claude_agent.py" park "Weekly Algo Review" --output-file "%REPORT%" < "%BRIEF%" >> "%REPORT%" 2>&1
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

echo [exit %CLAUDE_RC%] >> "%REPORT%"

REM Re-index the weekly reports so /dashboard/weekly.html shows this run. The page
REM reads a static JSON out of /dashboard rather than an endpoint, which is why it
REM needed no server route and no restart - so THIS line is what makes a new review
REM visible. Without it the analysis goes back to being written and never read,
REM which is the exact failure the page was built to end.
REM
REM Deliberately AFTER the exit marker and deliberately not allowed to change the
REM exit code: indexing is a reporting step, and a failed index must never turn a
REM successful review - or a correctly PARKED one - into a failed scheduled task.
node "%PROJ%\tasks\weekly_report_index.cjs" --quiet >> "%REPORT%" 2>&1

endlocal & exit /b %CLAUDE_RC%
