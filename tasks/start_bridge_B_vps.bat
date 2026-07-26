@echo off
cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set ACCOUNT_TAG=B
set MT5_TERMINAL_PATH=C:\MT5-B\terminal64.exe
set BRIDGE_LOG=tasks\logs\bridge_log_B.txt

REM MT5 in portable mode does NOT enforce single-instance the way a normal install
REM does. A second launch of the same install cannot bind the local IPC port the
REM Python MetaTrader5 client attaches to — the terminal log shows
REM "MCP bind error on 127.0.0.1:22346" — and from then on every mt5.initialize()
REM call fails with (-10005, 'IPC timeout'). The watchdog kill-loop of 2026-07-26
REM spawned exactly that duplicate, and the duplicate is what kept Bridge B from
REM ever connecting. Only launch a terminal if this specific install is not
REM already running.
powershell -NoProfile -Command "$running = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq '%MT5_TERMINAL_PATH%' } catch { $false } }; if ($running) { exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo [%date% %time%] Terminal already running for account %ACCOUNT_TAG% - not launching a second instance. >> %BRIDGE_LOG%
) else (
    echo [%date% %time%] Launching MT5 terminal for account %ACCOUNT_TAG%. >> %BRIDGE_LOG%
    start "" /min "%MT5_TERMINAL_PATH%" /portable
    timeout /t 5 /nobreak >nul
)

python mt5_bridge.py --auto >> %BRIDGE_LOG% 2>&1
