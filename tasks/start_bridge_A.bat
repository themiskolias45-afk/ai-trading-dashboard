@echo off

REM Resolve the interpreter before anything uses it. Bare `python` follows PATH,
REM and on 2026-08-23 PATH here pointed at a uv trampoline that Smart App Control
REM had begun blocking - every python call on the box died at once for 8h32m.
REM Falls back to bare `python`, so a box that works today selects what it always did.
call "%~dp0resolve_python.bat"
title SmartEntry MT5 Bridge - ACCOUNT A (Program Files terminal)
cd /d C:\Users\User\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set ACCOUNT_TAG=A
set MT5_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
REM Pinning the terminal path pins the install, not the account — two installs can
REM hold the same login. MT5_EXPECTED_LOGIN makes the bridge refuse to trade if this
REM terminal is logged into anything other than account A.
set MT5_EXPECTED_LOGIN=25446287

REM Per-symbol spread cap. Vantage quotes BTCUSD with a ~$17 spread that the bridge
REM measures as ~1700 ticks, against a global cap of 50 - so every BTC trade was
REM skipped before an order was built, and it read as 'no signal' in the log. 55 such
REM skips were recorded on this laptop. Gold (22) and SP500 (36) stay on the global cap.
set MAX_SPREAD_BTCUSD=2500

REM How long a loss-streak halt stands before the bridge releases itself, decaying the
REM streak by one. 1 hour, NOT the 48 the code defaults to.
REM
REM THIS FILE IS THE LAPTOP'S LAUNCHER ONLY. The VPS has a copy of it — it is tracked —
REM but nothing there runs it: scheduled task SmartEntryBridgeA launches
REM tasks\start_bridge_A_vps.bat instead. Any env var set here must be set there too,
REM or it silently applies to one box. That is how this setting was nearly deployed to
REM the box it mattered least on.
REM
REM The default is written for an account where a halt protects capital. These are DEMO
REM accounts at a fixed 0.01 lot: the capital a long pause protects is worth nothing,
REM and the thing it costs — closed trades — is the single binding constraint on this
REM system, which has one closed fill in its whole life. A 48h pause on the box that
REM trades continuously buys no safety and spends the only currency that is scarce.
REM The guard still exists and still fires; it just stops costing two days of evidence.
set HALT_COOLDOWN_HOURS=1

REM TRAILING LADDER ON, by operator decision 2026-09-03.
REM
REM Arms at 1.0R, then ratchets the stop in 0.5R steps staying 0.5R behind:
REM   profit 1.0R -> SL at entry +0.5R,  1.5R -> +1.0R,  2.0R -> +1.5R.
REM Applies to EVERY position this bridge manages - it is per-position, not per-symbol.
REM
REM THE MEASUREMENT SAYS OFF, AND IT IS RECORDED HERE RATHER THAN LOST. mt5_bridge.py
REM carries the table: give-back 0.5 looked 5/5 ROBUST at five folds and went NEGATIVE in
REM four folds when re-cut at four and seven; off is the only setting never negative under
REM any scheme. Total R favours 0.5 (+61.9 vs +28.2) from more trades and one lucky window.
REM Capping the runners cost more than the give-back saved.
REM
REM Turned on anyway, deliberately: the operator wants stops that protect open profit, and
REM a ladder that exists but is permanently off is decoration. Revert by setting this to 0
REM - one line, nothing else to undo, and the ladder never moves a stop AGAINST a position.
set TRAIL_LADDER_ENABLED=1

REM Full-auto unless the caller explicitly asks for SEMI. This is the single place
REM account A's identity is defined, so semi-auto callers set BRIDGE_MODE=SEMI and
REM come through here rather than invoking mt5_bridge.py themselves — an untagged
REM bridge auto-detects whichever terminal answers first and can double a tagged
REM account.
REM
REM Tested against `if not defined BRIDGE_ARGS` first: `set "BRIDGE_ARGS="` in the
REM caller UNDEFINES the variable, so semi-auto would have silently become full-auto.
REM An explicit mode cannot fail that way.
if /i "%BRIDGE_MODE%"=="SEMI" (set "BRIDGE_ARGS=") else (set "BRIDGE_ARGS=--auto")

echo.
echo  SmartEntry MT5 Bridge - ACCOUNT A - FULL AUTO MODE
echo  Terminal: %MT5_TERMINAL_PATH%
echo  STRONG signals execute instantly. Semi-auto for MODERATE.
echo  Risk: 1%% per trade. Circuit breaker: 3 consecutive losses.
echo  Press Ctrl+C to stop.
echo.
"%PY%" mt5_bridge.py %BRIDGE_ARGS% >> tasks\logs\bridge_log_A.txt 2>&1
REM ---------------------------------------------------------------------------
REM `pause` PARKED THIS SHELL FOREVER whenever the launcher was started by
REM automation, and it leaked one stuck cmd.exe per attempt.
REM
REM Measured 2026-08-27. ensure_running.ps1:331 starts this with
REM   Start-Process cmd -ArgumentList '/c','tasks\start_bridge_A.bat'
REM and safe_server_restart.ps1 goes through ensure_running, so EVERY server restart
REM tried to refill the bridge. When one is already running the python exits at once
REM - correctly, that is the one-bridge-per-account guard - and the shell then sat on
REM this line waiting for a keypress that never came. Six such shells were found
REM alive, 152-187 minutes old, each with a conhost and NO python child, three of
REM them created within 20 minutes by consecutive restarts. Inert, but they
REM accumulate, and a launcher that cannot be run twice is one automation cannot use.
REM
REM `timeout` is BOUNDED: a human still gets 30 seconds to read the window, and an
REM automated caller with no console gets an immediate error and the shell EXITS.
REM
REM NOT REMOVED, BOUNDED - deleting the wait would take the window away from someone
REM who double-clicked this to find out why it failed. The exit code is recorded
REM first, because the reason python stopped is the thing you actually want and it
REM was being thrown away.
REM ---------------------------------------------------------------------------
set "BRIDGE_EXIT=%ERRORLEVEL%"
echo [%DATE% %TIME%] start_bridge_A exited with code %BRIDGE_EXIT% >> "tasks\logs\bridge_starts.txt"
echo.
echo  Bridge A stopped (exit code %BRIDGE_EXIT%). Closing in 30s.
timeout /t 30 >nul 2>&1
