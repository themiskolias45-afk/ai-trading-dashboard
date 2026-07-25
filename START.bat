@echo off
title SmartEntry Pro — STARTING...
cd /d "%~dp0"
if not exist tasks\logs mkdir tasks\logs

echo.
echo  ==========================================
echo   SmartEntry Pro — AUTO LAUNCH
echo  ==========================================
echo.

REM ── Load API keys ──────────────────────────────────────────────
if exist keys.env (
  for /f "usebackq tokens=1,* delims==" %%a in ("keys.env") do set "%%a=%%b"
)
if exist server\apikey.txt (
  set /p ANTHROPIC_API_KEY=<server\apikey.txt
)

REM ── Stop only our own previous processes — never touch other node/python ──
REM (a prior version of this script killed every node.exe and python.exe on
REM  the whole machine by image name, which also silently killed unrelated
REM  tools and reset both MT5 bridges to a single untagged instance on every
REM  login. Window-title scoping matches tasks\watchdog.bat's safe pattern.)
echo  [0] Stopping previous SmartEntry processes...
taskkill /F /FI "WINDOWTITLE eq SmartEntry Server*"    >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq SmartEntry Watchdog*"  >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq SmartEntry Bridge*"    >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq SmartEntry MT5 Bridge*" >nul 2>&1
timeout /t 2 /nobreak >nul

REM ── Skip git reset — system runs from local files ─────────────
echo  [1] Using local files (no git reset — your changes are safe).

REM ── Start server ───────────────────────────────────────────────
echo  [2] Starting SmartEntry server...
start "SmartEntry Server" cmd /k "cd /d "%~dp0server" && node index.js"
timeout /t 8 /nobreak >nul

REM ── Verify server is up ────────────────────────────────────────
curl -s --max-time 6 http://localhost:3001/api/signals >nul 2>&1
if errorlevel 1 (
  echo  [2] WARNING: server not responding yet — check the server window
) else (
  echo  [2] Server: ONLINE — http://localhost:3001/dashboard
)

REM ── Open JARVIS in browser ──────────────────────────────────────
echo  [3] Opening JARVIS...
start "" "http://localhost:3001/jarvis"
timeout /t 2 /nobreak >nul

REM ── Start watchdog ─────────────────────────────────────────────
echo  [4] Starting watchdog (auto-restarts server if it crashes)...
start "SmartEntry Watchdog" /min cmd /c "tasks\watchdog.bat"

REM ── Launch both MT5 terminals (dual-account setup) ─────────────
REM Launching terminal64.exe again when that specific install is already
REM running just activates its existing window (MT5 is single-instance per
REM install) — safe to call unconditionally rather than guess at state.
echo  [5] Ensuring both MT5 terminals are running...
if exist "C:\Program Files\MetaTrader 5\terminal64.exe" (
  start "" /min "C:\Program Files\MetaTrader 5\terminal64.exe"
) else (
  echo  [5] WARNING: Account A terminal not found at C:\Program Files\MetaTrader 5
)
if exist "C:\Users\User\AppData\Roaming\MetaTrader 5\terminal64.exe" (
  start "" /min "C:\Users\User\AppData\Roaming\MetaTrader 5\terminal64.exe"
) else (
  echo  [5] WARNING: Account B terminal not found at C:\Users\User\AppData\Roaming\MetaTrader 5
)
echo  [5] Waiting 30 seconds for terminals to connect...
timeout /t 30 /nobreak >nul

REM ── Start both MT5 bridges, each pinned to its own terminal/account ────
echo  [6] Starting MT5 bridges A and B (full-auto, one per account)...
start "" /min cmd /k "%~dp0tasks\start_bridge_A.bat"
timeout /t 3 /nobreak >nul
start "" /min cmd /k "%~dp0tasks\start_bridge_B.bat"
timeout /t 3 /nobreak >nul
echo  [6] Bridges A and B: running in background.

REM ── Open JARVIS (Claude AI session) ────────────────────────────
echo  [7] Opening JARVIS...
where claude >nul 2>&1
if not errorlevel 1 (
  start "JARVIS" cmd /k "cd /d "%~dp0" && claude"
  echo  [7] JARVIS: ready.
) else (
  echo  [7] Claude CLI not found in PATH — open manually with: claude
)

:done
echo.
echo  ==========================================
echo   SMARTENTRY PRO IS LIVE
echo   JARVIS:     http://localhost:3001/jarvis
echo   Dashboard:  http://localhost:3001/dashboard
echo   Logs:       tasks\logs\
echo   To stop:    close the server window
echo  ==========================================
echo.
REM If run manually, pause so the user can read the output.
REM If auto-started at login (no interactive session), skip the pause.
echo %SESSIONNAME% | findstr /i "Console RDP" >nul 2>&1
if not errorlevel 1 (
  pause
)
