@echo off
REM ============================================================================
REM BAR REFRESH — runs daily, acts rarely, refuses safely.
REM
REM Scheduled at 04:45, fifteen minutes before SmartEntryStrategySearch at 05:00,
REM so that on any morning the book is flat the search runs against bars that
REM moved rather than re-testing the same history and calling it work.
REM
REM It REFUSES on any day a position is open, because export_mt5_history.py opens
REM a second MT5 python client and a conflict can drop the live bridge, leaving an
REM open trade unmanaged. Exit 3 means exactly that refusal and is the EXPECTED
REM result most days - it is not a failure and must not be alerted on as one.
REM
REM Nothing is deleted: the existing CSVs are copied to tasks\history\bak-<stamp>\
REM before the exporter runs, and a verification failure restores from that copy.
REM ============================================================================

REM Portable on purpose: %~dp0 is this file's own folder, so ONE batch serves both
REM boxes. The laptop lives at C:\Users\User\ai-trading-dashboard and the VPS at
REM C:\ai-trading-dashboard, and a second near-identical .bat would drift from
REM this one the first time either was edited. The filename still says _vps because
REM the VPS scheduled task points at it by absolute path.
cd /d "%~dp0.."
if not exist tasks\logs mkdir tasks\logs

set LOG=tasks\logs\refresh_bars.txt
echo. >> %LOG%
echo ========== %date% %time% ========== >> %LOG%

node tasks\refresh_bars.cjs --execute >> %LOG% 2>&1
set RC=%ERRORLEVEL%

if %RC%==0 (
  echo Bars refreshed >> %LOG%
) else if %RC%==3 (
  echo Refused - a position is open. Expected on most days, nothing was changed. >> %LOG%
) else (
  echo FAILED rc=%RC% - read the lines above >> %LOG%
)

exit /b %RC%
