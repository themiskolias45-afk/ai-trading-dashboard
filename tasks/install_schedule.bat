@echo off
setlocal enabledelayedexpansion
title SmartEntry Pro - Install Scheduled Tasks

REM ===========================================================================
REM  Register the legacy SmartEntry schedule.
REM
REM    tasks\install_schedule.bat            DRY RUN - shows what it would do
REM    tasks\install_schedule.bat /execute   actually registers
REM
REM  WHY THIS WAS REWRITTEN, 2026-08-30. Three faults, in order of how much
REM  damage each could do:
REM
REM  1. IT OVERWRITES LIVE TASKS. Every schtasks call carries /f, which replaces
REM     an existing task without asking. "SmartEntry - Daily Check" and
REM     "SmartEntry - Weekly Algo Review" are registered and working right now;
REM     a double-click on this file would silently replace both with whatever
REM     this script happens to say. That is why it is DRY RUN by default and
REM     names what it would overwrite before doing it.
REM
REM  2. THE PROJECT PATH WAS HARDCODED to C:\Users\User\ai-trading-dashboard,
REM     five times. That directory does not exist on the VPS, whose project
REM     lives at C:\ai-trading-dashboard - so running this there would register
REM     four tasks pointing at nothing, each failing every run forever. The path
REM     now comes from %~dp0.. , so the file is correct on whichever box it sits.
REM
REM  3. NOTHING CHECKED THAT THE TARGETS EXIST. A task pointing at a missing
REM     .bat fails on every trigger and reports it nowhere anyone reads - the
REM     exact "absent reads the same as fine" shape this project keeps hitting.
REM     Each target is now verified before it is registered, and a missing one
REM     is skipped with a reason rather than registered broken.
REM
REM  It DELETES nothing. The removal hint at the end is a note for a human, not
REM  something this script runs.
REM ===========================================================================

set "PROJ=%~dp0.."
pushd "%PROJ%" >nul 2>&1
set "PROJ=%CD%"
popd >nul 2>&1

set "MODE=DRY RUN"
if /i "%~1"=="/execute" set "MODE=EXECUTE"

echo.
echo  ==========================================
echo   SmartEntry schedule installer [%MODE%]
echo   project: %PROJ%
echo   box:     %COMPUTERNAME%
echo  ==========================================
echo.

set "FAILED=0"

call :plan "SmartEntry - Daily Check"        "tasks\auto_daily.bat"  "MON,TUE,WED,THU,FRI" "07:30"
call :plan "SmartEntry - Signal Scan 09:00"  "tasks\auto_signal.bat" "MON,TUE,WED,THU,FRI" "09:00"
call :plan "SmartEntry - Signal Scan 13:00"  "tasks\auto_signal.bat" "MON,TUE,WED,THU,FRI" "13:00"
call :plan "SmartEntry - Signal Scan 17:00"  "tasks\auto_signal.bat" "MON,TUE,WED,THU,FRI" "17:00"
call :plan "SmartEntry - Weekly Algo Review" "tasks\auto_weekly.bat" "SUN"                 "10:00"

echo.
if "%MODE%"=="DRY RUN" (
  echo  DRY RUN - nothing was registered. Re-run with:  install_schedule.bat /execute
) else (
  echo  Done. Review in Task Scheduler, or:  schtasks /query /tn "SmartEntry - Daily Check"
)
echo.
echo  To remove one by hand (this script never deletes):
echo    schtasks /delete /tn "SmartEntry - Daily Check" /f
echo.
exit /b %FAILED%


:plan
REM  %1 task name   %2 relative target   %3 days   %4 time
set "TASKNAME=%~1"
set "TARGET=%PROJ%\%~2"
set "DAYS=%~3"
set "WHEN=%~4"

if not exist "%TARGET%" (
  echo  [SKIP] %TASKNAME%
  echo         target missing: %TARGET%
  echo         refusing to register a task that would fail on every trigger.
  set "FAILED=1"
  goto :eof
)

schtasks /query /tn "%TASKNAME%" >nul 2>&1
if errorlevel 1 (
  set "VERB=CREATE"
) else (
  set "VERB=REPLACE - this task already exists and is registered"
)

echo  [!VERB!] %TASKNAME%
echo         %TARGET%
echo         %DAYS% at %WHEN%

if not "%MODE%"=="EXECUTE" goto :eof

schtasks /create /tn "%TASKNAME%" /tr "\"%TARGET%\"" /sc WEEKLY /d %DAYS% /st %WHEN% /f >nul 2>&1
if errorlevel 1 (
  echo         FAILED to register - schtasks returned %errorlevel%
  set "FAILED=1"
) else (
  echo         registered.
)
goto :eof
