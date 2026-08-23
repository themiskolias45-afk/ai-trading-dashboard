@echo off
REM ============================================================================
REM Sets %PY% to the interpreter that actually RUNS on this box.
REM
REM   call "%~dp0resolve_python.bat"
REM   "%PY%" some_script.py
REM
REM WHY: bare `python` resolves through PATH, and on 2026-08-23 PATH on the laptop
REM pointed at a uv trampoline for an interpreter Windows Smart App Control had
REM begun blocking. Every python call on the box died at once for 8h32m - the MT5
REM bridge, the nightly rejection-ledger pipeline, the daily plan and both persist
REM tools - behind a healer reading 8/8 green. A binary that EXISTS and sits first
REM on PATH tells you nothing about whether it can spawn.
REM
REM The decision is not made here. This shells out to server/python_path.js, which
REM is the one resolver in this repo, so batch, PowerShell and Node cannot drift
REM apart and start disagreeing about which python is the real one.
REM
REM FALLS BACK TO bare `python` when nothing resolves, which is exactly what every
REM caller did before this file existed. It can make a broken box work; it cannot
REM make a working box worse. A caller that would rather refuse should test
REM `if "%PY%"=="python"` only when it also knows python is dead - simpler is to
REM let the spawn fail where it always failed.
REM ============================================================================
set "PY="
for /f "usebackq delims=" %%p in (`node "%~dp0resolve_python.cjs" 2^>nul`) do set "PY=%%p"
if not defined PY set "PY=python"
exit /b 0
