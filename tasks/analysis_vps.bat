@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
REM Nightly parallel analysis. Runs on the VPS so it does not depend on the
REM laptop being open.
REM
REM Must run as an INTERACTIVE task (schtasks /it) under Administrator. The
REM claude CLI reads its OAuth token from the user's DPAPI-protected credential
REM store, which a network logon cannot decrypt - a task without /it reports
REM "Not logged in" on a box that is logged in perfectly well.
REM
REM Six replays feed one measured fact pack, five analysts read it in parallel,
REM a synthesiser merges them, and any proposal naming a tunable setting goes
REM through tasks\evaluate_change.py. Nothing is applied automatically: the
REM report is written and waits to be read.

cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set LOG=tasks\logs\analysis.txt
echo. >> %LOG%
echo ========== %date% %time% ========== >> %LOG%

REM D1 and H4 together give ~714 replayed trades. Anything shorter than H4 makes
REM the replay slow enough to overlap the 2 AM auto-tune, and two node replays
REM competing for the same box makes both of them late.
"%PY%" parallel_analysis.py --tf D1,H4 >> %LOG% 2>&1

if %ERRORLEVEL%==0 (
  echo Analysis complete - report at tasks\analysis\latest.json >> %LOG%
) else (
  echo Analysis FAILED with code %ERRORLEVEL% - see above >> %LOG%
)
