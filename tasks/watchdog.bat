@echo off
setlocal enabledelayedexpansion
title SmartEntry Watchdog
cd /d C:\Users\User\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

REM A bridge that was just restarted is not a dead bridge - it is a starting one.
REM A cold start costs the MT5 terminal launch plus the bridge's own connect retry
REM loop (6 attempts, 15s apart = 90s) before it can post a first heartbeat. With a
REM 60s cycle and no hold-off the watchdog kills it before it can ever report in,
REM and the restart itself becomes the thing keeping it down. That is not
REM theoretical: it is exactly what happened to Bridge B on the VPS, which logged
REM 3462 lines of startup banner and never one connect result. It has not bitten
REM this machine only because the local terminals are already logged in and connect
REM fast. Same guard, same reasoning. Raise this if you shorten the cycle below.
set BRIDGE_STARTUP_GRACE_CYCLES=3
set /a COOL_A=0
set /a COOL_B=0

REM The watchdog is the thing that restarts everything else, so its own death is the
REM most expensive silent failure on the box. It used to log only when it ACTED, which
REM meant a dead watchdog and a perfectly healthy one produced identical logs: nothing.
REM On 2026-08-01 it died within ~3 minutes of starting and bridge A then sat blind for
REM 28 minutes with the healer correctly reporting it down and nobody acting on it.
REM A heartbeat every N cycles makes silence mean death, which is the only way absence
REM can be an alarm. Keep this well under any alert threshold that reads the log.
set HEARTBEAT_EVERY_CYCLES=10
set /a CYCLE=0

REM How long a just-restarted bridge is left alone, in seconds. Must comfortably
REM exceed a cold start: MT5 terminal launch plus the bridge's 6 x 15s connect retry
REM loop. Enforced via a marker file so it survives a watchdog restart.
set BRIDGE_RESTART_COOLDOWN_SEC=180

REM Single-instance guard. watchdog_guardian.bat has one for itself (:44-51) and one
REM for its child (:71-86), but those only serialise the GUARDIAN'S launch.
REM tasks\start_all.bat:23 and tasks\startup.bat:27 start this file directly and
REM bypass the guardian entirely, so nothing stopped a second instance. On
REM 2026-08-14 that stacked one: the pair logged three "BRIDGE B DOWN" lines at
REM 19:50:34.80, :36.90 and :38.75 - gaps of 2.1s and 1.85s, which is the
REM `timeout /t 2` inside the restart branch below. A single 60s-paced loop cannot
REM produce that. Counting our own cmd.exe is expected, so more than one is real.
REM
REM count_watchdogs.ps1 fails SAFE to 99, so an unreadable process list exits here
REM rather than starting a possible duplicate. That is the guardian's own stated
REM trade-off and it is not a dead end: the guardian relaunches 10s later and
REM ensure_running.ps1 covers the gap on its own schedule. Two watchdogs racing a
REM server restart is the failure that is NOT recoverable.
set WATCHDOGS=99
for /f "usebackq delims=" %%N in (`powershell -NoProfile -ExecutionPolicy Bypass -File "tasks\count_watchdogs.ps1"`) do set WATCHDOGS=%%N
if %WATCHDOGS% GTR 1 (
  REM No parentheses in this text: a literal ^) inside an if-block closes the block
  REM early and cmd then tries to run the remainder as a command.
  echo [%date% %time%] Watchdog already running - %WATCHDOGS% found - this instance exited. >> tasks\logs\watchdog_log.txt
  exit /b 0
)

echo [%date% %time%] Watchdog started. >> tasks\logs\watchdog_log.txt

:loop
set /a CYCLE+=1
set /a HB=!CYCLE! %% !HEARTBEAT_EVERY_CYCLES!
if !HB! EQU 1 echo [!date! !time!] heartbeat - cycle !CYCLE!, watchdog alive. >> tasks\logs\watchdog_log.txt
REM Check if server responds (5 second timeout)
curl -s --max-time 5 http://localhost:3001/api/signals >nul 2>&1
if errorlevel 1 (set SERVER_DOWN=1) else (set SERVER_DOWN=0)

REM The server branch needs the same cooldown the bridge branches have, and for a
REM sharper reason: the bridges are serialised by their marker file, this was not
REM serialised by anything. On 2026-08-08 two watchdogs ran side by side for 40
REM minutes - one orphaned, one owned by the guardian - and had the server gone down
REM in that window, BOTH would have taskkilled it and BOTH would have started node.
REM The loser takes EADDRINUSE and dies, which is already a familiar line in
REM tasks\logs\server_err.txt. The marker is written BEFORE the taskkill so the race
REM window is as small as it can be, and it is a FILE so it outlives a watchdog that
REM is itself churning.
call :recent_restart SERVER
if !SERVER_DOWN! EQU 1 if !RECENT! EQU 0 (
    echo restarted > "tasks\logs\.restart_SERVER"
    echo [!date! !time!] SERVER DOWN - restarting... >> tasks\logs\watchdog_log.txt
    echo  [WATCHDOG] Server down - restarting...

    REM Kill only the SmartEntry Server window (safe - won't kill other node processes)
    taskkill /f /fi "windowtitle eq SmartEntry Server" >nul 2>&1
    timeout /t 3 /nobreak >nul

    REM Restart server
    start "SmartEntry Server" /min cmd /c "cd server && node index.js >> tasks\logs\server_log.txt 2>&1"
    timeout /t 12 /nobreak >nul

    REM Verify restart worked
    curl -s --max-time 8 http://localhost:3001/api/signals >nul 2>&1
    if errorlevel 1 (
        echo [!date! !time!] RESTART FAILED - server still down. >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Restart failed. Check tasks\logs\server_log.txt
    ) else (
        echo [!date! !time!] Server recovered OK. >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Server back online.
    )
) else (
    REM Chained `if A if B (...) else (...)` binds this else to the INNER if, so it is
    REM reached only when the server is down AND a restart is still in cooldown. A
    REM healthy server skips the whole construct and logs nothing, which is correct --
    REM do not add a re-test of SERVER_DOWN here, it can only ever be true.
    echo [!date! !time!] SERVER DOWN but a restart is still within cooldown - waiting. >> tasks\logs\watchdog_log.txt
)

REM -- MT5 bridge watchdog - restart only the specific account that went stale --
REM /api/mt5/health returns 503 only once a PREVIOUSLY-connected bridge goes silent
REM (never-connected-yet is 200, so a slow first boot never triggers a false restart).
REM The cooldown is a FILE, not just the in-memory counter. COOL_A resets to 0 every
REM time this script starts, so a watchdog that is itself churning would re-enter the
REM restart branch on each fresh launch and stack duplicate bridges on a live account
REM — every signal executed twice, at double risk. The marker file outlives the
REM process, so the hold-off holds no matter how often the watchdog is restarted.
call :recent_restart A
if !RECENT! EQU 1 (
    set /a COOL_A=0
) else if !COOL_A! GTR 0 (
    set /a COOL_A-=1
) else (
    curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=A" >nul 2>&1
    if errorlevel 1 (
        echo [!date! !time!] BRIDGE A DOWN - restarting... >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Bridge A down - restarting...
        REM /t or the cmd wrapper dies and its python child is orphaned: it keeps its
        REM MT5 connection and its ACCOUNT_TAG, so the restart below stacks a SECOND
        REM bridge on the same account and every signal executes twice. START.bat was
        REM fixed for this in 12e0c12; this file was missed.
        taskkill /f /t /fi "windowtitle eq SmartEntry MT5 Bridge - ACCOUNT A*" >nul 2>&1
        timeout /t 2 /nobreak >nul
        start "" /min cmd /k "tasks\start_bridge_A.bat"
        echo restarted > "tasks\logs\.restart_A"
        set /a COOL_A=!BRIDGE_STARTUP_GRACE_CYCLES!
        echo [!date! !time!] Bridge A restart triggered - holding off !BRIDGE_STARTUP_GRACE_CYCLES! cycles. >> tasks\logs\watchdog_log.txt
    )
)

REM Bridge B only exists on machines that own tag B. MT5_EXPECTED_ACCOUNTS in
REM keys.env is the single source of truth, shared with the server's healer and
REM ensure_running.ps1. Local B and the VPS's A were both pinned to login 11581419
REM with separate circuit breakers; without this check the watchdog restarts that
REM duplicate within 60 seconds of it being stopped.
REM
REM Fails CLOSED, not open. This defaulted to "A,B", so ANY failure to read keys.env
REM became "start a bridge for an account this box may not own" -- precisely the
REM outcome the check exists to prevent, reached by the one path nobody tests. A box
REM that owns B and cannot read its config loses B monitoring until the file is
REM readable, and both ensure_running.ps1 and the server's healer report that
REM independently; a box that does not own B can never start a duplicate.
set "EXPECTED_TAGS="
REM /c: is required. Without it findstr splits the pattern on spaces and treats each
REM piece as its own search term, so "[ ]*=" alone matched any line containing "=" --
REM a keys.env holding FOO=bar set EXPECTED_TAGS to "bar". Caught in trace, not live.
for /f "tokens=2 delims==" %%T in ('findstr /r /c:"^ *MT5_EXPECTED_ACCOUNTS *=" keys.env 2^>nul') do set "EXPECTED_TAGS=%%T"
REM Logged on cycle 1 only: this is a config fault, not a per-minute event, and a
REM line every 60s would bury the restart lines this file exists to make visible.
if "!EXPECTED_TAGS!"=="" if !CYCLE! EQU 1 echo [!date! !time!] MT5_EXPECTED_ACCOUNTS unreadable - bridge B not watched this run. >> tasks\logs\watchdog_log.txt
if "!EXPECTED_TAGS!"=="" goto :skip_bridge_b
echo !EXPECTED_TAGS! | findstr /i "B" >nul
if errorlevel 1 goto :skip_bridge_b

call :recent_restart B
if !RECENT! EQU 1 (
    set /a COOL_B=0
) else if !COOL_B! GTR 0 (
    set /a COOL_B-=1
) else (
    curl -sf --max-time 5 "http://localhost:3001/api/mt5/health?account=B" >nul 2>&1
    if errorlevel 1 (
        echo [!date! !time!] BRIDGE B DOWN - restarting... >> tasks\logs\watchdog_log.txt
        echo  [WATCHDOG] Bridge B down - restarting...
        taskkill /f /t /fi "windowtitle eq SmartEntry MT5 Bridge - ACCOUNT B*" >nul 2>&1
        timeout /t 2 /nobreak >nul
        start "" /min cmd /k "tasks\start_bridge_B.bat"
        echo restarted > "tasks\logs\.restart_B"
        set /a COOL_B=!BRIDGE_STARTUP_GRACE_CYCLES!
        echo [!date! !time!] Bridge B restart triggered - holding off !BRIDGE_STARTUP_GRACE_CYCLES! cycles. >> tasks\logs\watchdog_log.txt
    )
)

:skip_bridge_b

REM Check every 60 seconds
timeout /t 60 /nobreak >nul
goto loop


REM ── Subroutines ───────────────────────────────────────────────────────────────
:recent_restart
REM %1 = what was restarted: an account tag (A, B) or SERVER. Sets RECENT=1 if it was
REM restarted less than BRIDGE_RESTART_COOLDOWN_SEC ago, 0 otherwise.
REM
REM Marker files are .restart_%1, renamed from .bridge_%1_restart on 2026-08-08 when
REM the server started using this too and ".bridge_SERVER_restart" would have been a
REM lie. The markers are transient - they only matter for
REM BRIDGE_RESTART_COOLDOWN_SEC - so no old file needed migrating.
REM
REM PowerShell rather than batch date arithmetic on purpose: %date%/%time% maths in
REM cmd is locale-dependent and wrong across midnight and month boundaries, and a
REM cooldown that silently fails open at midnight would stack duplicate bridges at
REM exactly the hour nobody is watching.
set RECENT=0
if not exist "tasks\logs\.restart_%~1" exit /b 0
for /f "usebackq delims=" %%R in (`powershell -NoProfile -Command "$f='tasks\logs\.restart_%~1'; $age=((Get-Date)-(Get-Item $f).LastWriteTime).TotalSeconds; if ($age -lt %BRIDGE_RESTART_COOLDOWN_SEC%) { '1' } else { '0' }"`) do set RECENT=%%R
exit /b 0
