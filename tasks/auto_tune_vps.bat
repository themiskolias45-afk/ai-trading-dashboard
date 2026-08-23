@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
REM Nightly evidence-gated auto-tune. Runs on the VPS.
REM
REM One setting per night, rotating, so a bad day cannot move several dials at
REM once and leave you unable to tell which one did it. Each run replays the live
REM engine over exported MT5 bars, splits train/test, and only writes a new value
REM if it beat the current one out-of-sample on a majority of assets.
REM
REM Only tunes WHICH trades qualify - never lot size. Position sizing is not
REM something an unattended process should decide.
REM
REM Requires tasks\history\*.csv. export_mt5_history.py refreshes those.

cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set LOG=tasks\logs\auto_tune.txt
echo. >> %LOG%
echo ========== %date% %time% ========== >> %LOG%

REM Rotate on day-of-week so each setting gets tested regularly but only one
REM changes per night.
for /f %%d in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek.value__"') do set DOW=%%d

REM Only adxTrendingMin is tested, because it is the only tunable the replay can
REM actually see. confidenceThreshold lives in generateSignalMTF and the position
REM and trade caps are enforced in the bridge - testing those returned KEEP every
REM time regardless of value, which looked like "no improvement found" but was
REM really "the harness cannot measure this".
if "%DOW%"=="1" set SETTING=adxTrendingMin& set VALUES=15,20,25,30& set BASE=20

if "%SETTING%"=="" (
  echo No tuning scheduled today ^(day %DOW%^) >> %LOG%
  goto :eof
)

echo Testing %SETTING% over %VALUES% ^(current %BASE%^) >> %LOG%
REM PROPOSE-ONLY since 2026-08-22. The --apply flag was withdrawn from the line below.
REM Nothing was removed from evaluate_change.py - the capability is intact and this is
REM reversible by putting the flag back. Two reasons it was withdrawn:
REM   1. An overnight job that writes a live threshold by itself is the one behaviour
REM      the owner asked never to happen. A recommendation costs nothing if it is wrong.
REM   2. The restart branch below could never have worked on this box anyway.
REM      SmartEntryServer is Interactive/AtLogOn and fails 0x800710E0 headless, so an
REM      apply would have stopped the server and left it down until the SYSTEM ensure
REM      task recovered it - up to 10 minutes off the air, on the box that trades.
REM THE SWEEP STILL RUNS IN FULL and still logs its verdict. No measurement is lost and
REM nothing is blocked; only the automatic WRITE is withheld.
"%PY%" tasks\evaluate_change.py --setting %SETTING% --values %VALUES% --baseline %BASE% --tf H4 >> %LOG% 2>&1

REM Exit code 0 means a variant won and was written. Restart the server so it
REM loads the new value, then say so on Telegram - a config that changed itself
REM overnight should never be a surprise.
if %ERRORLEVEL%==0 (
  echo RECOMMENDATION found and NOT applied - decide it by hand >> %LOG%
  REM Former apply branch, kept so restoring it is a copy not a rewrite.
  REM Do not re-enable without fixing the restart: schtasks cannot start
  REM SmartEntryServer on this headless box. Use safe_server_restart.ps1
  REM -Execute then SmartEntryEnsureRunning.
  REM   schtasks /end /tn SmartEntryServer
  REM   timeout /t 4 /nobreak
  REM   schtasks /run /tn SmartEntryServer
  powershell -NoProfile -ExecutionPolicy Bypass -File tasks\vps_notify.ps1 -Mode heartbeat >nul 2>&1
) else (
  echo No change - current setting retained >> %LOG%
)
