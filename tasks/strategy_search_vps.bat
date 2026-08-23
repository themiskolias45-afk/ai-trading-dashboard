@echo off
REM ============================================================================
REM CONTINUOUS STRATEGY SEARCH — one round per day, one axis per round.
REM
REM WHY DAILY AND NOT A LOOP. The bars only change once a day. A tighter loop
REM re-tests identical data, finds identical answers, and inflates the ledger's
REM candidate count for no new information — which matters because that count is
REM what tells a reader whether a winner is "best of 12" or "best of 4,000".
REM Running more often would make the searcher LOOK busier and its findings
REM WEAKER. Once a day, rotating axes, is the honest version of "always searching".
REM
REM WHY IT IS SAFE TO SCHEDULE ON THE BOX THAT TRADES:
REM   - strategy_search.cjs cannot write a setting, a gate or a threshold. It
REM     writes a report and a ledger row. Nothing here restarts the server.
REM   - it never touches the journal, learning.json, the rejection ledger or any
REM     trade record. Read-only against replays of historical bars.
REM   - a run that proposes nothing is the expected outcome and exits 0.
REM
REM AXIS ROTATION — one axis per weekday, seven axes, a full cycle every week.
REM Widened from two axes on 2026-08-23. A fixed weekday per axis is deliberate:
REM "when was adx last asked" is answerable by looking at a calendar rather than
REM by doing modular arithmetic against a run count.
REM
REM   Sun ceiling      3 cuts, ~20 min - the slowest
REM   Mon gate         1 cut,  quick
REM   Tue rsi          1 cut
REM   Wed minrr        2 cuts (5-fold and 4-fold), multi-replay sweep
REM   Thu adx          2 cuts
REM   Fri minstrength  2 cuts
REM   Sat trail        2 cuts
REM
REM One per night keeps the CPU cost bounded on a 4-vCPU box that is also the box
REM that trades. Running the whole set nightly would be more search per day only
REM if the DATA moved each day, and it does not - see --skip-if-bars-unchanged.
REM ============================================================================

cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set LOG=tasks\logs\strategy_search.txt
echo. >> %LOG%
echo ========== %date% %time% ========== >> %LOG%

REM Locale-independent day-of-week, same approach as auto_tune_vps.bat: slicing
REM %date% breaks on a different regional format and has done here before.
for /f %%d in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek.value__"') do set DOW=%%d

REM DayOfWeek.value__ is 0=Sunday .. 6=Saturday, so this is a straight lookup and
REM every axis is asked exactly once a week.
set AXIS=ceiling
if "%DOW%"=="1" set AXIS=gate
if "%DOW%"=="2" set AXIS=rsi
if "%DOW%"=="3" set AXIS=minrr
if "%DOW%"=="4" set AXIS=adx
if "%DOW%"=="5" set AXIS=minstrength
if "%DOW%"=="6" set AXIS=trail

echo Axis for day %DOW%: %AXIS% >> %LOG%

REM --skip-if-bars-unchanged: exit 4 without running anything when the cached bars
REM have not moved since the last round. A nightly re-test of identical data returns
REM identical answers while the ledger's candidate count climbs, and that count is
REM what tells a reader whether a winner is "best of 12" or "best of 4,000". A human
REM running this by hand deliberately does NOT pass the flag and always gets an answer.
node tasks\strategy_search.cjs --axis %AXIS% --skip-if-bars-unchanged >> %LOG% 2>&1
set RC=%ERRORLEVEL%

REM Exit 1 means an axis failed to score, which is a HARNESS problem and worth
REM seeing. Exit 0 covers both "found nothing" and "found something", because a
REM searcher that exits non-zero on its normal outcome trains whoever reads the
REM log to ignore it. What was found is in the report, not the exit code.
if %RC%==0 (
  echo Search round complete >> %LOG%
) else if %RC%==4 (
  echo Skipped - bars unchanged since the last round, so nothing was run. Expected >> %LOG%
  echo   on any day tasksefresh_bars_vps.bat has not found a flat book yet. >> %LOG%
) else (
  echo SEARCH ROUND FAILED rc=%RC% - see the report and the lines above >> %LOG%
)

echo Report: tasks\analysis\strategy-search-latest.txt >> %LOG%
exit /b %RC%
