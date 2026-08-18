@echo off
cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set ACCOUNT_TAG=A
set MT5_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
set BRIDGE_LOG=tasks\logs\bridge_log_A.txt

REM Per-symbol spread cap. Vantage quotes BTCUSD with a ~$17 spread, which the
REM bridge measures as ~1700 ticks - against the global cap of 50 that rejected
REM every BTC trade before an order was sent, and read as 'no signal' in the logs.
REM Gold (22) and SP500 (36) stay on the global cap and are unaffected.
set MAX_SPREAD_BTCUSD=2500

REM How long a loss-streak halt stands before the bridge releases itself, decaying the
REM streak by one. 1 hour, NOT the 48 the code defaults to.
REM
REM This matters MORE here than on the laptop: this is the box that trades
REM continuously, and it is the one that sat at 3 of 3 losses. The code default is
REM written for an account where a pause protects capital. This is a DEMO account at a
REM fixed 0.01 lot, so the capital protected is worth nothing while the cost - closed
REM trades - is the single binding constraint on the whole system. The guard still
REM exists and still fires; it just stops costing two days of evidence to do it.
REM
REM Set it HERE, not in tasks\start_bridge_A.bat. That file is tracked and present on
REM this box but nothing runs it: scheduled task SmartEntryBridgeA launches THIS file.
REM Editing the other one looks like a deploy and changes nothing.
set HALT_COOLDOWN_HOURS=1

REM Pin to the account, not just the install. The terminal path alone does not stop
REM this bridge trading whatever login the terminal happens to hold, and two
REM bridges on one account place every trade twice at double risk. This is the only
REM demo account the VPS has (VantageMarkets-Demo), so if a second bridge ever
REM appears here it must use a DIFFERENT account, not this one.
set MT5_EXPECTED_LOGIN=11581419

REM Same guard as account B. This install is not portable so Windows is more
REM likely to refuse a duplicate on its own, but "more likely" is not a guarantee
REM and a duplicate here breaks the IPC port the Python MetaTrader5 client needs
REM in exactly the same way (-10005 'IPC timeout'). Only launch a terminal if this
REM specific install is not already running.
powershell -NoProfile -Command "$running = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq '%MT5_TERMINAL_PATH%' } catch { $false } }; if ($running) { exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo [%date% %time%] Terminal already running for account %ACCOUNT_TAG% - not launching a second instance. >> %BRIDGE_LOG%
) else (
    echo [%date% %time%] Launching MT5 terminal for account %ACCOUNT_TAG%. >> %BRIDGE_LOG%
    start "" /min "%MT5_TERMINAL_PATH%"
    timeout /t 5 /nobreak >nul
)

python mt5_bridge.py --auto >> %BRIDGE_LOG% 2>&1
