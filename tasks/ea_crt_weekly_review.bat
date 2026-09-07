@echo off
REM WEEKLY review of EA_CRT_AMD_Dashboard - profitability and stability, that EA alone.
REM
REM Refreshes the trade ledger first so the review reads current broker truth rather than
REM whatever the last hourly sweep happened to catch, then runs the EA-only review.
REM
REM SmartEntry is deliberately NOT in scope here. The chart EA is a separate system with
REM its own magic, config and record, and pooling the two produces a number that describes
REM neither. This file never reports on the bridge or its executors.
REM
REM Read-only: no order, no stop, no close, no setting, no signal path, nothing deleted.
REM It cannot block, delay or suppress a trade.
setlocal
cd /d "%~dp0.."
set LOG=tasks\logs\ea_crt_weekly_review.txt
if not exist tasks\logs mkdir tasks\logs

echo. >> "%LOG%"
echo ===== %DATE% %TIME% ===== >> "%LOG%"

REM Both terminals, so a trade on either account is present before the review runs.
python tasks\trade_ledger_reconcile.py >> "%LOG%" 2>&1
python tasks\trade_ledger_reconcile.py "C:\Program Files\MetaTrader 5\terminal64.exe" >> "%LOG%" 2>&1

python tasks\ea_crt_weekly_review.py >> "%LOG%" 2>&1

endlocal
