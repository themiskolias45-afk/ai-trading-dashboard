@echo off
REM Launch Edge with the TradingView profile and the CDP port the bot attaches to.
REM
REM ASCII ONLY. cmd.exe reads this as ANSI and a non-ASCII byte becomes mojibake.
REM
REM WHY IT IS PATH-AGNOSTIC NOW
REM It used to hardcode `cd /d C:\Users\User\ai-trading-dashboard` and the profile
REM `C:\Users\User\AppData\Local\...`. Both are LAPTOP-ONLY paths. On the Contabo VPS the
REM project lives at C:\ai-trading-dashboard and the user is `administrator`, so neither
REM path exists and the launcher could not run there at all - which is why TradingView had
REM never once connected from that box, even though its TV_USERNAME and TV_PASSWORD were
REM present and correct the whole time. The credentials were never the blocker.
REM
REM %~dp0 is this script's own folder, so `%~dp0..` is the project root wherever it sits.
REM %LOCALAPPDATA% resolves to the SAME directory the old hardcoded profile named when run
REM as the laptop user, so the laptop keeps its existing logged-in session and does not
REM have to sign in again.
REM
REM   tasks\launch_chrome_tv.bat            launch and wait for the port
REM   tasks\launch_chrome_tv.bat /check     report only, launch nothing

setlocal
title Launch Edge for TradingView

cd /d "%~dp0.."
set "TV_PROFILE=%LOCALAPPDATA%\Microsoft\Edge\SmartEntryTV"

REM Edge lives in Program Files on some builds and Program Files (x86) on others.
REM Probing beats guessing: the old script named one path and would have failed silently
REM on any box with the other.
set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

echo   project : %CD%
echo   profile : %TV_PROFILE%
if not defined EDGE goto :no_edge
echo   edge    : %EDGE%

REM ALREADY UP IS A SUCCESS, NOT A REASON TO LAUNCH AGAIN. tv_daily_plan.ps1 says it in
REM one line: two browsers on one CDP port is its own failure mode. If the port answers,
REM this script has nothing to do.
netstat -an | findstr /C:":9222" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 goto :already_up

if /I "%~1"=="/check" goto :check_only

echo   launching...
REM --start-maximized DID NOT HOLD. Measured on the VPS 2026-09-05: the window came up
REM 734x726 on a 1536x864 desktop, and with TradingView's widget panel open the chart
REM canvas was ~400px - too narrow for the plan table, which then rendered off-canvas
REM while every check still reported the study as applied. An explicit size and
REM position is deterministic where the flag was not. The bot also re-checks and
REM corrects the width on every run, because a launch flag cannot fix a window that
REM something resized later.
start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%TV_PROFILE%" --no-first-run --no-default-browser-check --window-position=0,0 --window-size=1536,824 "https://www.tradingview.com/chart/"

REM Poll rather than sleep a fixed 4 seconds: a cold profile on a loaded box takes longer,
REM and a fixed wait reports failure for a browser that was merely slow.
set /a TRIES=0
:wait_loop
set /a TRIES+=1
ping -n 3 127.0.0.1 >nul
netstat -an | findstr /C:":9222" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 goto :port_open
if %TRIES% LSS 10 goto :wait_loop

echo   WARNING: port 9222 never opened after 20 seconds.
echo   Close every Edge window using this profile and run it again.
endlocal
exit /b 3

:port_open
echo   OK: Edge is listening on 9222. The bot can attach.
echo   If this profile has never signed in to TradingView, sign in once in that window.
endlocal
exit /b 0

:already_up
echo   OK: something is already listening on 9222 - not launching a second browser.
endlocal
exit /b 0

:check_only
echo   /check: nothing is on 9222 and no browser was launched.
endlocal
exit /b 1

:no_edge
echo   ERROR: msedge.exe was not found in either Program Files location.
endlocal
exit /b 2
