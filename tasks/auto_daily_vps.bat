@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
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
"%PY%" "%PROJ%\tasks\score_rr_rejections.py" >> "%LOGFILE%" 2>&1
"%PY%" "%PROJ%\tasks\learning_from_rejections.py" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Shadow short ledger, added 2026-08-28. The rejection ledger above prices setups that
REM FORMED and were then killed by a gate. This one prices the moves for which no setup
REM exists at all: on 2026-08-28 Gold fell 4631 -> 4530 in one H1 bar and produced no
REM signal, no rejection row and no near-miss, because every learning surface here keys
REM off a setup forming. A move that leaves no row cannot be learned from or argued
REM about. It matters MORE on this box, which is the one that trades continuously.
REM
REM SAFE BY CONSTRUCTION, and it must stay that way:
REM   - feedsTheGate is false in every row. It admits nothing and suppresses nothing.
REM   - it reads /api/mt5/candles/raw, the bars the bridge already pushed, so it opens NO
REM     second MT5 client and is safe to run with positions open - unlike refresh_bars,
REM     which correctly refuses whenever this box is holding a trade.
REM   - the ledger is append-only and idempotent; the derived _scored file is written to
REM     a temp, the outgoing version copied to a VERIFIED timestamped .bak, then swapped.
REM     Nothing is deleted, ever.
REM   - the forming bar is excluded by index. A partial bar is a wrong row, not a late one.
REM Exit code deliberately NOT captured, exactly like the ledger steps above: an empty
REM ledger is a normal early state, not a failed daily check, and this must never be able
REM to fail the run or delay the doctor self-test below it.
echo --- shadow short ledger --- >> "%LOGFILE%"
"%PY%" "%PROJ%\tasks\shadow_short_ledger.py" >> "%LOGFILE%" 2>&1

REM ---- measurement steps the VPS was missing ----------------------------
REM All five scripts were already present on this box; only this runner never
REM called them. So the VPS wrote near_misses.jsonl and stop_variants.jsonl and
REM scored neither - a writer with no reader, on the box that actually trades
REM and therefore produces the fills the evidence is about.
REM
REM Read-only measurement. No gate, no threshold, no signal, no order. Exit
REM codes deliberately NOT captured: a failing measurement must never turn a
REM good daily run red, and must never block anything.
echo --- near-miss + stop-variant scorers --- >> "%LOGFILE%"
node "%PROJ%\tasks\score_near_misses.cjs" --emit >> "%LOGFILE%" 2>&1
node "%PROJ%\tasks\score_stop_variants.cjs" --emit >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

echo --- config drift --- >> "%LOGFILE%"
node "%PROJ%\tasks\config_drift.cjs" --emit >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

echo --- calibration drift --- >> "%LOGFILE%"
"%PY%" "%PROJ%\tasks\calibration_drift_alert.py" --silent >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Feeds the 1D read / 4H read rows on the daily plan. candle-today.json did
REM not exist on this box at all, so the VPS daily plan carried neither.
echo --- next-candle read --- >> "%LOGFILE%"
node "%PROJ%\tasks\candle_probability.cjs" XAUUSD BTCUSD SP500 >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Will the CLI agents still be able to sign in tomorrow? On 2026-08-28 this
REM box's OAuth session expired, both autonomous agents died at the auth layer,
REM and NOTHING WATCHED FOR IT. Reads the refresh-token expiry from the
REM credentials file: free, no API call, no token ever printed.
REM
REM Exit code deliberately NOT captured - a reporting step must never turn a
REM good daily run red. It publishes dashboard\agent-auth.json for the Fleet Map.
echo --- agent auth --- >> "%LOGFILE%"
node "%PROJ%\tasks\agent_auth_check.cjs" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM Index the nightly deep analysis for /dashboard/analysis.html. THIS box writes
REM the report at 01:00 (SmartEntryAnalysis), so by 07:30 it is fresh. 542 KB, 825
REM replayed trades, and no page had ever fetched it - trimmed here to a 10 KB
REM artifact the page loads straight out of /dashboard: no route, no restart.
REM
REM Exit code deliberately not captured - a reporting step must never turn a good
REM daily run red.
echo --- analysis index --- >> "%LOGFILE%"
node "%PROJ%\tasks\analysis_index.cjs" >> "%LOGFILE%" 2>&1

REM Every pipeline stage, and whether anything reads what it writes. Runs LAST so
REM it sees the artifacts every step above just produced.
echo --- pipeline index --- >> "%LOGFILE%"
node "%PROJ%\tasks\pipeline_index.cjs" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

REM ── Do the doctor's own checks still fire? ────────────────────────────────────
REM Identical to the block in tasks\auto_daily.bat, and it matters MORE here: this is
REM the box that trades continuously, and every expensive failure on it has been a
REM silent one behind green checks. Deterministic, no AI, no network, about two seconds.
REM Placed BEFORE the agent so its verdict is on record whether the claude call
REM succeeds, fails or parks.
REM
REM PER-RUN file, not an append: the doctor reads it and must be able to judge THIS run.
REM The [selftest exit N] line is written AFTER the run, so its ABSENCE is the
REM fingerprint of a run that died partway, which the doctor reports as unknown rather
REM than good. SELFTEST_RC is NOT folded into CLAUDE_RC - a broken self-test surfaces as
REM a doctor finding instead of burying the daily check's own result.
set "SELFTEST_OUT=%PROJ%\tasks\logs\doctor_selftest_last.txt"
echo --- doctor self-test --- >> "%LOGFILE%"
node "%PROJ%\tasks\doctor_selftest.cjs" > "%SELFTEST_OUT%" 2>&1
set SELFTEST_RC=%ERRORLEVEL%
echo [selftest exit %SELFTEST_RC%] >> "%SELFTEST_OUT%"
type "%SELFTEST_OUT%" >> "%LOGFILE%"
echo. >> "%LOGFILE%"

pushd "%AGENTCWD%"
call claude -p "Daily SmartEntry Pro automated check. 1) Read %PROJ%\server\journal.json if it exists - last 5 trades with outcome and P&L; if absent say 'no trades yet'. 2) Fetch http://localhost:3001/api/strategy-settings and use its confidenceThreshold as THE gate - never assume a number. If settingsError is not null say so first: the server is on built-in defaults, not the saved config. 3) Fetch http://localhost:3001/api/signals - all 3 assets: signal, confidence, setup, dataSource, updatedAt. Call out any asset whose indicators are unchanged from the previous check while another asset moved - that is a frozen feed. BUT FIRST read barFreshness.spansWeekend for that asset: when it is true the market is simply closed (Gold and SPX do not trade at the weekend, BTC does), which is NOT a frozen feed and must not be reported as one. Only call it frozen when spansWeekend is false and the indicators are genuinely stuck. 4) Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses, halted. 5) Fetch http://localhost:3001/api/learning - setupStats progress toward the 5-trades-per-setup threshold. 6) Any signal at or above the live gate must be marked ** SIGNAL READY **. 7) One-line verdict: TRADE TODAY or WAIT. Under 25 lines. Report only, do not edit code." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul > "%RUNOUT%" 2>&1
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
    echo another moved - that is a frozen feed. BUT FIRST read barFreshness.spansWeekend for that asset: when it is true the market is simply closed (Gold and SPX do not trade at the weekend, BTC does), which is NOT a frozen feed and must not be reported as one. Only call it frozen when spansWeekend is false and the indicators are genuinely stuck. Mark any signal at or above the gate
    echo SIGNAL READY.
    echo Fetch http://localhost:3001/api/risk-status - daily P&L, consecutive losses, halted.
    echo Fetch http://localhost:3001/api/learning - setupStats progress toward the
    echo 5-trades-per-setup threshold.
    echo End with a one-line verdict: TRADE TODAY or WAIT. Under 25 lines, report only.
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
