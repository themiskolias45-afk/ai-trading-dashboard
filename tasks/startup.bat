@echo off
title SmartEntry Pro - Auto Startup
cd /d C:\Users\User\ai-trading-dashboard

if not exist tasks\logs mkdir tasks\logs
echo [%date% %time%] SmartEntry startup... >> tasks\logs\startup_log.txt

REM 1 — Start Node server in background
echo  Starting SmartEntry server...
start "SmartEntry Server" /min cmd /c "cd server && node index.js >> ..\tasks\logs\server_log.txt 2>&1"

REM 2 — Wait for server to boot
timeout /t 8 /nobreak >nul

REM 3 — Launch Edge with TradingView (dedicated SmartEntryTV profile + debug port)
REM     Dedicated profile = always its own process, port 9222 always binds correctly
echo  Launching Edge with TradingView...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\User\AppData\Local\Microsoft\Edge\SmartEntryTV" ^
  --no-first-run ^
  --start-maximized ^
  "https://www.tradingview.com/chart/"

REM 4 — Start watchdog (monitors server, auto-restarts if it crashes)
echo  Starting server watchdog...
start "SmartEntry Watchdog" /min cmd /c "tasks\watchdog.bat"

REM 4 — Backup data
call tasks\backup_data.bat

REM 4 — Launch MT5 if not already running
tasklist /fi "imagename eq terminal64.exe" 2>nul | find /i "terminal64.exe" >nul
if errorlevel 1 (
  echo  MT5 not running — launching...
  REM MT5 install path (confirmed: C:\Program Files\MetaTrader 5)
  if exist "C:\Program Files\MetaTrader 5\terminal64.exe" (
    start "" /min "C:\Program Files\MetaTrader 5\terminal64.exe"
    goto :wait_mt5
  )
  if exist "C:\Program Files (x86)\MetaTrader 5\terminal64.exe" (
    start "" /min "C:\Program Files (x86)\MetaTrader 5\terminal64.exe"
    goto :wait_mt5
  )
  echo  MT5 not found — set path in tasks\startup.bat line 30. Bridge skipped.
  goto :done
)
echo  MT5 already running.
goto :start_bridge

:wait_mt5
echo  Waiting 30 seconds for MT5 to connect...
timeout /t 30 /nobreak >nul

:start_bridge
REM Exactly one bridge per real MT5 account, never an untagged extra. An untagged
REM "python mt5_bridge.py" auto-detects whichever terminal answers first, which puts
REM it on the same broker account as Bridge B — two --auto bridges on one account
REM open every signal twice, and the 3-loss circuit breaker counts per ACCOUNT_TAG,
REM so neither tag ever reaches the halt. The tagged scripts pin terminal, tag and
REM expected login; only they are launched here.
echo  Starting MT5 bridges A and B...
REM /T so the cmd wrapper's python child dies with it — killing the wrapper alone
REM orphans the bridge, which then keeps trading across restarts.
taskkill /f /t /fi "windowtitle eq SmartEntry Bridge" >nul 2>&1
taskkill /f /t /fi "windowtitle eq SmartEntry MT5 Bridge - ACCOUNT A*" >nul 2>&1
taskkill /f /t /fi "windowtitle eq SmartEntry MT5 Bridge - ACCOUNT B*" >nul 2>&1
start "" /min cmd /k "tasks\start_bridge_A.bat"
timeout /t 3 /nobreak >nul

REM Bridge B only on machines that own tag B. MT5_EXPECTED_ACCOUNTS in keys.env is the
REM single source of truth, shared with the server's healer, ensure_running.ps1 and
REM tasks\bridge_tags.ps1. Local B and the VPS's A are both pinned to login 11581419;
REM without this check, starting everything here puts two --auto bridges on that one
REM account, and the 3-loss breaker counts per ACCOUNT_TAG so neither tag ever halts.
REM /c: is required -- without it findstr splits the pattern on spaces and any line
REM containing "=" matches, so a keys.env holding FOO=bar sets EXPECTED_TAGS to "bar".
REM Absent or unreadable value means A,B, never an empty list.
set "EXPECTED_TAGS=A,B"
for /f "tokens=2 delims==" %%T in ('findstr /r /c:"^ *MT5_EXPECTED_ACCOUNTS *=" keys.env 2^>nul') do set "EXPECTED_TAGS=%%T"
if "%EXPECTED_TAGS%"=="" set "EXPECTED_TAGS=A,B"
echo %EXPECTED_TAGS% | findstr /i "B" >nul
if errorlevel 1 (
  echo  Bridge B: not owned by this machine ^(MT5_EXPECTED_ACCOUNTS=%EXPECTED_TAGS%^) - skipped
) else (
  start "" /min cmd /k "tasks\start_bridge_B.bat"
)

:done
echo [%date% %time%] Startup complete. >> tasks\logs\startup_log.txt
echo.
echo  SmartEntry Pro is running.
echo   Server:  http://localhost:3001/dashboard
echo   Bridges: check tasks\logs\bridge_log_A.txt and tasks\logs\bridge_log_B.txt
echo   Logs:    tasks\logs\
echo.
