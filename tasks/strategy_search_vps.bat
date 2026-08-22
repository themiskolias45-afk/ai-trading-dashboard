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
REM Axis rotation: the ceiling axis has three independent cuts and takes ~20 min;
REM the gate axis has one and is quick. Alternating by day-of-week parity keeps
REM any single night's CPU cost bounded rather than running both every time.
REM ============================================================================

cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set LOG=tasks\logs\strategy_search.txt
echo. >> %LOG%
echo ========== %date% %time% ========== >> %LOG%

REM Locale-independent day-of-week, same approach as auto_tune_vps.bat: slicing
REM %date% breaks on a different regional format and has done here before.
for /f %%d in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek.value__"') do set DOW=%%d

set AXIS=gate
set /a ODD=%DOW% %% 2
if "%ODD%"=="0" set AXIS=ceiling

echo Axis for day %DOW%: %AXIS% >> %LOG%

node tasks\strategy_search.cjs --axis %AXIS% >> %LOG% 2>&1
set RC=%ERRORLEVEL%

REM Exit 1 means an axis failed to score, which is a HARNESS problem and worth
REM seeing. Exit 0 covers both "found nothing" and "found something", because a
REM searcher that exits non-zero on its normal outcome trains whoever reads the
REM log to ignore it. What was found is in the report, not the exit code.
if %RC%==0 (
  echo Search round complete >> %LOG%
) else (
  echo SEARCH ROUND FAILED rc=%RC% - see the report and the lines above >> %LOG%
)

echo Report: tasks\analysis\strategy-search-latest.txt >> %LOG%
exit /b %RC%
