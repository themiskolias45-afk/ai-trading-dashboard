@echo off
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
python tasks\evaluate_change.py --setting %SETTING% --values %VALUES% --baseline %BASE% --tf H4 --apply >> %LOG% 2>&1

REM Exit code 0 means a variant won and was written. Restart the server so it
REM loads the new value, then say so on Telegram - a config that changed itself
REM overnight should never be a surprise.
if %ERRORLEVEL%==0 (
  echo Applied - restarting server to load it >> %LOG%
  schtasks /end /tn SmartEntryServer >nul 2>&1
  timeout /t 4 /nobreak >nul
  schtasks /run /tn SmartEntryServer >nul 2>&1
  powershell -NoProfile -ExecutionPolicy Bypass -File tasks\vps_notify.ps1 -Mode heartbeat >nul 2>&1
) else (
  echo No change - current setting retained >> %LOG%
)
