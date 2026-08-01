@echo off
REM ── SmartEntry Guardian ───────────────────────────────────────────────────────
REM Supervises tasks\watchdog.bat and restarts it if it ever stops.
REM
REM Why this exists: the watchdog is what restarts the server and the MT5 bridges,
REM and it had exactly one owner — a fire-and-forget `start` line in START.bat.
REM Nothing watched the watcher. On 2026-08-01 it died roughly three minutes after
REM launch and bridge A then sat blind for 28 minutes: the healer detected the
REM outage correctly and no process was alive to act on it.
REM
REM Two deliberate details:
REM
REM  1. The watchdog runs in a SEPARATE process via `start /wait`, not `call`. A
REM     `call` would run it inside this same cmd.exe, so the taskkill that removes
REM     the watchdog would take the guardian with it — supervising nothing.
REM
REM  2. This window is titled "SmartEntry Guardian", NOT "SmartEntry Watchdog...".
REM     START.bat and tasks\start_all.bat both kill `WINDOWTITLE eq SmartEntry
REM     Watchdog*` on startup, and a guardian matching that wildcard would be
REM     killed by the very cleanup it is meant to survive.
REM
REM A Scheduled Task with RestartCount would be the tidier home for this, but
REM registering one needs elevation this process does not have. If you ever run an
REM elevated shell, tasks\install_watchdog_task.ps1 does exactly that and you can
REM drop the Startup-folder route.
REM ─────────────────────────────────────────────────────────────────────────────
title SmartEntry Guardian
cd /d "%~dp0.."
if not exist tasks\logs mkdir tasks\logs

set "WDLOG=tasks\logs\watchdog_log.txt"

REM Single-instance guard by PROCESS LIST, not by a lock file.
REM
REM A lock file held open on handle 9 looked simpler and was wrong: cmd hands its open
REM handles to every child it spawns, so the watchdog inherited the lock and then
REM passed it to the bridge wrapper it restarts. That wrapper long outlives both, so a
REM single bridge restart left the lock held permanently and no guardian could ever
REM start again. Caught live on 2026-08-01 before this shipped: PID 6776,
REM `cmd /k tasks\start_bridge_A.bat`, still holding .guardian.lock after its watchdog
REM and its guardian were both dead.
REM
REM Counting our own cmd.exe is expected, so more than one means a real duplicate.
set GUARDIANS=1
for /f "usebackq delims=" %%N in (`powershell -NoProfile -ExecutionPolicy Bypass -File "tasks\count_guardians.ps1"`) do set GUARDIANS=%%N
if %GUARDIANS% GTR 1 (
  REM No parentheses in this text: a literal ^) inside an if-block closes the block
  REM early and cmd then tries to run the remainder as a command.
  echo [%date% %time%] Guardian already running - %GUARDIANS% found - this instance exited. >> "%WDLOG%"
  exit /b 0
)

call :supervise
exit /b 0

:supervise
echo [%date% %time%] Guardian started - supervising watchdog. >> "%WDLOG%"
set /a RESTARTS=0
:guard_loop
REM /wait blocks here for the watchdog's entire life. Reaching the next line means
REM the watchdog stopped, which is always abnormal — it has no exit path of its own.
start "SmartEntry Watchdog" /min /wait cmd /c "tasks\watchdog.bat"
set /a RESTARTS+=1
echo [%date% %time%] WATCHDOG STOPPED (restart #%RESTARTS%) - relaunching in 10s. >> "%WDLOG%"
timeout /t 10 /nobreak >nul
goto guard_loop
