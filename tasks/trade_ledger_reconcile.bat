@echo off
REM Sweeps BOTH terminals on this box into tasks\all_trades_ledger.jsonl, then aggregates.
REM
REM Two sweeps, not one: mt5.initialize() with no path attaches to whichever terminal
REM answers first, so a single run records one account and silently omits the other.
REM The ledger is keyed on account:positionId, so running both in either order, at any
REM frequency, can only ever ADD rows - never duplicate and never remove one.
REM
REM Frequency is not a data-loss risk: each run sweeps the FULL broker history, so a
REM missed run is caught by the next. Hourly is for surface freshness, not safety.
REM
REM Read-only against MT5: no order, no stop, no close, no setting, no other ledger.
REM It cannot block, delay or suppress a trade. Safe to run at any time.
setlocal
cd /d "%~dp0.."
set LOG=tasks\logs\trade_ledger_reconcile.txt
if not exist tasks\logs mkdir tasks\logs

echo. >> "%LOG%"
echo ===== %DATE% %TIME% ===== >> "%LOG%"

REM Default terminal (whichever answers first).
python tasks\trade_ledger_reconcile.py >> "%LOG%" 2>&1

REM The other install explicitly, so the second account is never the one that is missed.
python tasks\trade_ledger_reconcile.py "C:\Program Files\MetaTrader 5\terminal64.exe" >> "%LOG%" 2>&1

REM Aggregate into tasks\trade_ledger_summary.json - per-model live performance, pooled
REM across both accounts and both boxes. Reads two files, writes one that nothing trades
REM from. feedsTheGate stays false: this measures, it does not decide.
python tasks\trade_ledger_summary.py >> "%LOG%" 2>&1

endlocal
