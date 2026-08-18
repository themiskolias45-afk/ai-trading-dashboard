@echo off
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
python mt5_bridge.py %BRIDGE_ARGS% >> tasks\logs\bridge_log_A.txt 2>&1
pause
