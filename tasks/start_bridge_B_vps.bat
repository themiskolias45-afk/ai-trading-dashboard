@echo off
cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

set ACCOUNT_TAG=B
set MT5_TERMINAL_PATH=C:\MT5-B\terminal64.exe

start "" /min "C:\MT5-B\terminal64.exe" /portable
timeout /t 5 /nobreak >nul

python mt5_bridge.py --auto >> tasks\logs\bridge_log_B.txt 2>&1
