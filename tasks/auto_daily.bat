@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
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
REM The claude call writes HERE first, then gets appended to LOGFILE. park decides by
REM READING the file it is given and refuses anything over 400 chars, so handing it
REM LOGFILE would never park: by the time the agent runs, LOGFILE already holds the
REM rejection-scoring and shadow-learning output and yesterday's ran to 14KB. LOGFILE
REM still receives exactly what it always did.
set RUNOUT=%PROJ%\tasks\logs\daily_run_%RANDOM%%RANDOM%.tmp

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
"%PY%" "%PROJ%\tasks\score_rr_rejections.py" >> "%LOGFILE%" 2>&1
"%PY%" "%PROJ%\tasks\learning_from_rejections.py" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM The two ledgers added 2026-08-27, scored here for the same reason the rejection
REM ledger is: a ledger nothing reads can never become a verdict, which is the exact
REM failure the near-miss census had for weeks.
REM Both are READ-ONLY against the engine - no threshold, no stop, no trade - and both
REM print PENDING rather than guessing while a horizon has not elapsed.
REM   near-miss    prices the RSI CEILING: the binding constraint on how often this
REM                system trades, and the only blocker with no rejection-ledger row.
REM   stop-variant asks whether a lower-timeframe stop would have paid, PAIRED against
REM                the baseline the engine actually traded on the same signal.
echo --- near-miss + stop-variant scorers --- >> "%LOGFILE%"
node "%PROJ%\tasks\score_near_misses.cjs" --emit >> "%LOGFILE%" 2>&1
node "%PROJ%\tasks\score_stop_variants.cjs" --emit >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Shadow short ledger, added 2026-08-28. The two scorers above price setups that FORMED
REM and were then killed. This one prices the moves for which no setup exists at all: on
REM 2026-08-28 Gold fell 4631 -> 4530 in one H1 bar and produced no signal, no rejection
REM row and no near-miss, because every learning surface here keys off a setup forming.
REM A move that leaves no row cannot be learned from or argued about - it is invisible.
REM
REM SAFE BY CONSTRUCTION, and it must stay that way:
REM   - feedsTheGate is false in every row. It admits nothing and suppresses nothing.
REM   - it reads /api/mt5/candles/raw, the bars the bridge already pushed, so it opens NO
REM     second MT5 client and is safe to run with positions open - unlike refresh_bars.
REM   - the ledger is append-only; the derived _scored file is written to a temp, backed
REM     up with a verified timestamped copy, then swapped. Nothing is ever deleted.
REM   - the forming bar is excluded by index. A partial bar is a wrong row, not a late one.
REM Exit code deliberately NOT captured, exactly like the scorers above: an empty ledger
REM is a normal early state, not a failed daily check, and this must never be able to fail
REM the run or delay a step below it.
echo --- shadow short ledger --- >> "%LOGFILE%"
"%PY%" "%PROJ%\tasks\shadow_short_ledger.py" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Config drift, added 2026-08-27. The same failure was found FIVE times in one session:
REM a number copied out of the config into a doc, a comment or a condition, the config
REM moves, and the copy stays. Nothing detects it because nothing BREAKS - the copy is
REM syntactically fine and merely lying. Read-only; --strict is deliberately NOT passed so
REM a drifted comment cannot fail the nightly run.
echo --- config drift --- >> "%LOGFILE%"
node "%PROJ%\tasks\config_drift.cjs" --emit >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Calibration drift check — compares live setup win rates against shadow stats.
REM Fires a notification if any setup has drifted > 15pp from expected.
REM --silent suppresses duplicate toasts (the agent's report already surfaces this).
REM Exit code deliberately NOT captured: a server-offline is not a failed daily check.
echo --- calibration drift --- >> "%LOGFILE%"
"%PY%" "%PROJ%\tasks\calibration_drift_alert.py" --silent >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Will the CLI agents still be able to sign in tomorrow? On 2026-08-28 the VPS
REM OAuth session expired, both autonomous agents died at the auth layer, and
REM NOTHING WATCHED FOR IT - the doctor inferred it a day later from task exit
REM codes. This reads the refresh-token expiry out of the credentials file: free,
REM no API call, no token ever printed.
REM
REM Exit code deliberately NOT captured. This is a REPORTING step and must never
REM turn a good daily run red - it publishes dashboard\agent-auth.json, which the
REM Fleet Map renders, and that is where the alarm belongs.
echo --- agent auth --- >> "%LOGFILE%"
node "%PROJ%\tasks\agent_auth_check.cjs" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Index the nightly deep analysis for /dashboard/analysis.html. The report is
REM 542 KB and NO PAGE HAS EVER FETCHED IT - the largest body of measurement this
REM system produces has been invisible its whole life. This trims it to a 10 KB
REM artifact the page loads directly out of /dashboard, so no route and no restart.
REM
REM On this box the report ARRIVES by the 04:00 VPS pull, which is why this runs
REM at 07:30 and not before. Exit code deliberately not captured: a reporting step
REM must never turn a good daily run red.
echo --- analysis index --- >> "%LOGFILE%"
node "%PROJ%\tasks\analysis_index.cjs" >> "%LOGFILE%" 2>&1

REM Every pipeline stage, and whether anything reads what it writes. Runs LAST so it
REM sees the artifacts every step above has just produced - an audit that ran first would
REM grade yesterday's run and quietly report it as today's.
REM Exit code not captured: a reporting step must never turn a good daily run red.
echo --- pipeline index --- >> "%LOGFILE%"
node "%PROJ%\tasks\pipeline_index.cjs" >> "%LOGFILE%" 2>&1

REM Daily page-quality audit. Every check is a defect that really shipped on these
REM pages - absent-as-zero, the deferred-script race, unescaped external text, an
REM orphan style, a missing shared include. It PROPOSES and never edits: not one
REM byte of any page is written, for the same reason the auto-tuner never writes a
REM threshold - a job that edits unattended breaks a page at 07:30 with nobody there.
REM Deterministic: no LLM, no tokens, so it still runs on the day the ceiling closes.
REM Always exits 0 - a quality finding must never fail a daily run.
echo --- page quality --- >> "%LOGFILE%"
node "%PROJ%\tasks\page_quality_audit.cjs" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM -- content quality: the panel that renders perfectly and says nothing ------
REM page_quality_audit reads the MARKUP and cannot tell a healthy panel from one
REM whose data has been null since the third of the month - both are the same HTML.
REM /daily-plan showed a price for every asset and every one was null for 26 days.
REM This reads what the pages actually fetch and reports unreachable, empty,
REM mostly-null, stale, frozen and never-populated panels.
REM GET ONLY, with a deny list for the routes that ACT on GET - /api/backtest runs
REM a 5-year backtest, /api/doctor SSHes to the peer, /api/chat spends tokens. That
REM list is self-tested every run and the job REFUSES to probe if it leaks.
REM Always exits 0 - a content finding must never fail a daily run.
echo --- content quality --- >> "%LOGFILE%"
node "%PROJ%\tasks\content_quality_audit.cjs" >> "%LOGFILE%" 2>&1

REM ── Next-candle read, for the TradingView plan panel ──────────────────────────
REM candle_probability.cjs writes tasks\analysis\candle-today.json, which is the ONLY
REM source for the "1D read" and "4H read" rows tradingview_bot.py puts on the chart
REM (it reads that file at tradingview_bot.py:1275).
REM
REM Until now NOTHING called it. Found 2026-08-26: a repo-wide grep returned only the
REM file's own usage comment, the server's "not generated yet" fallback and the bot's
REM reader - no scheduler entry, no script, no caller anywhere. The artifact was last
REM written 2026-08-24 17:51 and its rows were asOf 2026-08-21, so the chart had been
REM showing five-day-old geometry beside live prices with nothing saying so.
REM
REM Deterministic, no AI and no network: it replays cached bars. Exit code deliberately
REM not captured, same as the ledger steps above - a thin read is a normal early state,
REM not a failed daily check.
echo --- next-candle read --- >> "%LOGFILE%"
REM All three symbols, explicitly. Bare `candle_probability.cjs` defaults to XAUUSD
REM ONLY and rewrites candle-today.json with just those two rows - running it without
REM arguments cuts the artifact from 6 rows to 2 and silently blanks the BTC and SPX
REM read lines on the chart. Verified both ways on 2026-08-26.
node "%PROJ%\tasks\candle_probability.cjs" XAUUSD BTCUSD SP500 >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM ── Do the doctor's own checks still fire? ────────────────────────────────────
REM Deterministic, no AI, no network, about two seconds. Placed BEFORE the agent for
REM the same reason the ledger is: its verdict should be on record whether the claude
REM call succeeds, fails or parks.
REM
REM Writes a PER-RUN file, deliberately not an append. The doctor reads this file and
REM must be able to judge THIS run; a cumulative log could only ever say the suite
REM passed sometime, which is the same mistake as a marker written where nobody looks.
REM The [selftest exit N] line goes in AFTER the run, so its ABSENCE is the fingerprint
REM of a run that died partway - the doctor reports that as unknown rather than good.
REM
REM SELFTEST_RC is deliberately NOT folded into CLAUDE_RC. A broken self-test surfaces
REM as a doctor finding, and failing the whole daily task over it would bury the daily
REM check's own result behind an unrelated red.
set "SELFTEST_OUT=%PROJ%\tasks\logs\doctor_selftest_last.txt"
echo --- doctor self-test --- >> "%LOGFILE%"
node "%PROJ%\tasks\doctor_selftest.cjs" > "%SELFTEST_OUT%" 2>&1
set SELFTEST_RC=%ERRORLEVEL%
echo [selftest exit %SELFTEST_RC%] >> "%SELFTEST_OUT%"
type "%SELFTEST_OUT%" >> "%LOGFILE%"
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
REM Regenerate the briefing first so the agent reads TODAY's decisions, not a
REM stale copy. Cheap, read-only, and it is the difference between an agent that
REM re-proposes settled work and one that knows what has already been tried.
node "%PROJ%\tasks\ai_brief.cjs" --write >> "%LOGFILE%" 2>&1

REM CALL, not a bare invocation. `claude` resolves to claude.cmd, and running a
REM .CMD from a .BAT without CALL transfers control and never comes back — every
REM line below this one was dead. No [exit N] marker has ever been written to any
REM log in this project, the completion notification never fired, and endlocal
REM never ran. Found 2026-08-09 by the AI work ledger looking for the marker.
call claude -p "FIRST read %PROJ%\tasks\ai_brief.md - prior decisions, open proposals, what is already measured, and the live config. Never re-raise a decided item. Daily SmartEntry Pro automated check. 1) Read %PROJ%\server\journal.json - last 5 trades with outcome and P&L. 2) Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold as THE gate - never assume a number. If settingsError is not null, say so first: the server is on built-in defaults, not the saved config. 3) Fetch http://localhost:3001/api/signals - all 3 assets: signal, confidence, setup, dataSource. 4) Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses, halted. 5) Any signal at or above the live gate must be marked ** SIGNAL READY **. 6) Read %PROJ%\server\learning_shadow.json if it exists - per-setup evidence from REJECTED setups walked forward on real bars. These are paper results with no slippage, and they do NOT feed the live gate. Name any setup whose enoughForReading is true and say what its rPerEpisode implies. If the file is absent or every setup is still insufficient, say exactly that. 7) One-line verdict: TRADE TODAY or WAIT. Keep under 30 lines." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul > "%RUNOUT%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd
type "%RUNOUT%" >> "%LOGFILE%"

REM Notify, but never let the notifier decide this task's exit code - msg.exe
REM fails in a non-interactive session and would report a healthy run as failed.
msg * "SmartEntry: Daily check complete. See tasks\logs\ for report." >nul 2>&1

REM Park the brief when the subscription window is closed, instead of losing the day.
REM On 2026-08-12 the VPS morning agent died on "You have hit your weekly limit -
REM resets Aug 13, 11am" and threw its work away; a weekly ceiling kills every claude
REM job on the box at once, so this one would have gone the same way. park refuses
REM anything that is not a genuine limit notice, so a real failure still surfaces as a
REM failure. The brief goes in on STDIN because cmd.exe truncates an argument at the
REM first newline.
if not "%CLAUDE_RC%"=="0" (
  (
    echo Daily SmartEntry Pro automated check, resumed after a subscription limit.
    echo FIRST read %PROJ%\tasks\ai_brief.md - prior decisions, open proposals, what is
    echo already measured, and the live config. Never re-raise a decided item.
    echo Read %PROJ%\server\journal.json - last 5 trades with outcome and P&L.
    echo Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold
    echo as THE gate, never an assumed number. If settingsError is not null say so first:
    echo the server is then on built-in defaults, not the saved config.
    echo Fetch http://localhost:3001/api/signals - all 3 assets: signal, confidence,
    echo setup, dataSource. Mark any signal at or above the live gate SIGNAL READY.
    echo Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses,
    echo halted.
    echo Read %PROJ%\server\learning_shadow.json if it exists - per-setup evidence from
    echo REJECTED setups walked forward on real bars. These are paper results with no
    echo slippage and they do NOT feed the live gate. Name any setup whose
    echo enoughForReading is true and say what its rPerEpisode implies.
    echo End with a one-line verdict: TRADE TODAY or WAIT. Keep under 30 lines.
  ) | "%PY%" "%PROJ%\claude_agent.py" park "Daily Check" --output-file "%RUNOUT%" >> "%LOGFILE%" 2>&1
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

echo [exit %CLAUDE_RC%] >> "%LOGFILE%"
endlocal & exit /b %CLAUDE_RC%
