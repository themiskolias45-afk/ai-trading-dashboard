@echo off
title SmartEntry Pro - Manual Start
cd /d C:\Users\User\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

echo.
echo  ==========================================
echo   SmartEntry Pro - Starting Everything...
echo  ==========================================
echo.

REM 1 — Server
echo  [1/4] Starting server...
taskkill /f /fi "windowtitle eq SmartEntry Server" >nul 2>&1
start "SmartEntry Server" /min cmd /c "cd server && node index.js >> tasks\logs\server_log.txt 2>&1"
timeout /t 8 /nobreak >nul
curl -s --max-time 5 http://localhost:3001/api/signals >nul 2>&1
if errorlevel 1 (echo  [1/4] Server: FAILED - check tasks\logs\server_log.txt) else (echo  [1/4] Server: OK - http://localhost:3001/dashboard)

REM 2 — Watchdog
echo  [2/4] Starting watchdog...
taskkill /f /fi "windowtitle eq SmartEntry Watchdog" >nul 2>&1
start "SmartEntry Watchdog" /min cmd /c "tasks\watchdog.bat"
echo  [2/4] Watchdog: OK - auto-restarts server if it crashes

REM 3 — MT5
echo  [3/4] Checking MT5...
tasklist /fi "imagename eq terminal64.exe" 2>nul | find /i "terminal64.exe" >nul
if errorlevel 1 (
  echo  [3/4] MT5: launching...
  if exist "C:\Program Files\MetaTrader 5\terminal64.exe" (
    start "" /min "C:\Program Files\MetaTrader 5\terminal64.exe"
    echo  [3/4] MT5: started - waiting 30s to connect...
    timeout /t 30 /nobreak >nul
  ) else (
    echo  [3/4] MT5: NOT FOUND - open MT5 manually, then run tasks\start_bridge_A.bat and tasks\start_bridge_B.bat
    goto :summary
  )
) else (
  echo  [3/4] MT5: already running
)

REM 4 — Bridges: exactly one per real MT5 account, never an untagged extra.
REM     An untagged "python mt5_bridge.py" auto-detects whichever terminal answers
REM     first, which puts it on the same broker account as Bridge B. Two --auto
REM     bridges on one account open every signal twice, and the 3-loss circuit
REM     breaker counts per ACCOUNT_TAG, so neither tag ever reaches the halt.
REM     Only the tagged scripts launch here — they pin terminal, tag and login.
echo  [4/4] Starting MT5 bridges A and B...
REM /T so the cmd wrapper's python child dies with it. Without /T the wrapper is
REM killed and the bridge itself survives as an orphan, which is how a stray
REM untagged bridge outlived a restart and kept trading.
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
  echo  [4/4] Bridge B: not owned by this machine ^(MT5_EXPECTED_ACCOUNTS=%EXPECTED_TAGS%^) - skipped
  echo  [4/4] Bridges: OK - A #25446287
) else (
  start "" /min cmd /k "tasks\start_bridge_B.bat"
  timeout /t 5 /nobreak >nul
  echo  [4/4] Bridges: OK - A #25446287, B #11581419
)

:summary
echo.
echo  ==========================================
echo   Done.
echo   Server:    http://localhost:3001/dashboard
echo   Logs:      tasks\logs\
echo   Bridges:   tasks\logs\bridge_log_A.txt  tasks\logs\bridge_log_B.txt
echo   Watchdog:  tasks\logs\watchdog_log.txt
echo  ==========================================
echo.
pause
