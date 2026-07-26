@echo off
cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set ACCOUNT_TAG=A
set MT5_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe

start "" /min "C:\Program Files\MetaTrader 5\terminal64.exe"
timeout /t 5 /nobreak >nul

python mt5_bridge.py --auto >> tasks\logs\bridge_log_A.txt 2>&1
