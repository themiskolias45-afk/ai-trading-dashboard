@echo off
REM SmartEntry data backup.
REM
REM WIDENED 2026-09-10. It used to copy TWO files - journal.json and learning.json -
REM and nothing else. Everything below was unprotected, measured on the laptop that day:
REM
REM   server\smartentry.db              114,688 B   the SQLite trade + learning database
REM   tasks\all_trades_ledger.jsonl   7,455,566 B
REM   tasks\rejections_scored.jsonl   2,606,285 B
REM   tasks\rejections.jsonl          2,110,430 B
REM   tasks\near_misses.jsonl           396,821 B
REM   tasks\decision_register.jsonl     255,970 B
REM   tasks\jarvis_memory.json          129,972 B
REM   tasks\breaker_state_A.json            283 B   circuit-breaker state
REM   tasks\analysis\                       145 MB  583 files
REM   ...and eleven more ledgers
REM
REM NOTHING WAS REMOVED. The four original copy lines are unchanged and run first, so
REM if anything below fails the old behaviour has already happened.
REM
REM The big trees use ROBOCOPY /XO into a single mirror rather than a dated copy: a
REM dated copy of tasks\analysis would write 145 MB every run. /XO copies only files
REM newer than the target, so the first run is the full size and later runs are the
REM delta. History for the small critical files is still kept per-day.
REM
REM ROBOCOPY EXIT CODES ARE NOT SHELL EXIT CODES: 0 = nothing to do, 1 = files copied,
REM 2 = extra files, 3 = both. Only 8 and above is a real failure. Treating 1 as an
REM error is the classic way a working backup gets reported as broken.

setlocal EnableDelayedExpansion

REM Derive the project root from this file's own location. The original hardcoded
REM C:\Users\User\ai-trading-dashboard, which is the LAPTOP path - the same class of
REM fault that pinned four other tools to one box.
cd /d "%~dp0.."

REM Create backup folder with today's date
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set BACKUP_DIR=tasks\backups\%DT:~0,8%
set MIRROR_DIR=tasks\backups\_mirror

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
if not exist "%MIRROR_DIR%" mkdir "%MIRROR_DIR%"

REM ---------------------------------------------------------------------------
REM ORIGINAL FOUR LINES - unchanged, and first, so the pre-existing guarantee holds
REM even if everything added below were to fail.
REM ---------------------------------------------------------------------------
if exist server\journal.json     copy /Y server\journal.json     %BACKUP_DIR%\journal.json     >nul
if exist server\learning.json    copy /Y server\learning.json    %BACKUP_DIR%\learning.json    >nul
if exist server\journal.json     copy /Y server\journal.json     tasks\backups\journal_latest.json >nul
if exist server\learning.json    copy /Y server\learning.json    tasks\backups\learning_latest.json >nul

REM ---------------------------------------------------------------------------
REM ADDED: the rest of the irreplaceable state.
REM ---------------------------------------------------------------------------
set COPIED=0
set MISSING=0

for %%F in (
    "server\smartentry.db"
    "server\learning_shadow.json"
    "server\hermes_state.json"
    "server\strategy_settings.json"
    "server\trading_control.json"
    "tasks\breaker_state_A.json"
    "tasks\all_trades_ledger.jsonl"
    "tasks\rejections.jsonl"
    "tasks\rejections_scored.jsonl"
    "tasks\near_misses.jsonl"
    "tasks\confluence_ledger.jsonl"
    "tasks\stop_variants.jsonl"
    "tasks\shadow_shorts.jsonl"
    "tasks\shadow_shorts_scored.jsonl"
    "tasks\strategy_search_ledger.jsonl"
    "tasks\lab_curator_ledger.jsonl"
    "tasks\lab_shadow.jsonl"
    "tasks\ai_decisions.jsonl"
    "tasks\decision_register.jsonl"
    "tasks\trade_ledger_summary.json"
    "tasks\jarvis_memory.json"
) do (
    if exist %%F (
        copy /Y %%F "%BACKUP_DIR%\" >nul
        if not errorlevel 1 set /a COPIED+=1
    ) else (
        set /a MISSING+=1
    )
)

REM ---------------------------------------------------------------------------
REM Trees. /XO = skip files older than the target, so only changes are written.
REM /R:1 /W:2 so a locked file costs seconds, not the whole run.
REM ---------------------------------------------------------------------------
set TREEFAIL=0
for %%D in (analysis daily eod_reports decision_corpus) do (
    if exist "tasks\%%D" (
        robocopy "tasks\%%D" "%MIRROR_DIR%\%%D" /E /XO /R:1 /W:2 /NP /NFL /NDL /NJH /NJS >nul
        if errorlevel 8 set /a TREEFAIL+=1
    )
)

echo [%date% %time%] Backup: %COPIED% file(s) to %BACKUP_DIR%, %MISSING% absent, trees mirrored to %MIRROR_DIR%, treeFail=%TREEFAIL% >> tasks\logs\backup_log.txt

REM A tree failure is the only thing worth a non-zero exit. Absent files are not an
REM error: not every box carries every ledger.
if %TREEFAIL% GTR 0 exit /b 1
exit /b 0
