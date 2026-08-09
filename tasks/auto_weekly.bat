@echo off
REM Runs Sunday 10:00 via Task Scheduler.
REM Analyses the week, proposes ONE improvement, saves report, waits for manual approval.
REM
REM Same clean-room rule as the daily and morning jobs: launched inside the project
REM the agent loads CLAUDE.md, boots as JARVIS and refuses to work unattended. The
REM only weekly report ever produced (26/07, 75 bytes) contains nothing but the two
REM header lines this script echoed - the agent contributed zero bytes.
setlocal
REM PROJ comes from this file's own location (%~dp0 is tasks\, so .. is the
REM project root) and AGENTCWD from %LOCALAPPDATA% - never hardcoded. The laptop
REM keeps the project under C:\Users\User and the VPS at C:\ai-trading-dashboard,
REM so a hardcoded path silently breaks on the other box.
for %%I in ("%~dp0..") do set "PROJ=%%~fI"
set "AGENTCWD=%LOCALAPPDATA%\SmartEntryAgentCwd"
set NONINTERACTIVE=You are a non-interactive subprocess in an automated pipeline. There is no human reading your output and no one to answer a question. Never greet, never introduce yourself, never ask for confirmation. Write the file you are asked to write, then stop.

if not exist "%AGENTCWD%" mkdir "%AGENTCWD%"
if not exist "%PROJ%\tasks\logs" mkdir "%PROJ%\tasks\logs"
REM Date from PowerShell, not from slicing %date%.
REM
REM %date% is LOCALE-dependent and the two boxes disagree. The VPS gives
REM "Fri 08/07/2026" (US, with a weekday prefix) where the old slices
REM %date:~-10,2%%date:~-7,2% land on MM then DD and are correct. This laptop gives
REM "07/08/2026" (UK, no prefix) where the same slices land on DD then MM, so every
REM filename came out with day and month transposed: the report written on 7 August
REM was named weekly_20260708 and reads as 8 July. Worse on two-digit days -
REM weekly_20262607 (26 July) and daily_20262107 (21 July) carry month "26" and "21"
REM and no date parser will take them. The Python-written daily_runner_* files next
REM to them are correct, which is what makes the .bat ones obviously wrong.
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "TODAY=%%D"
set REPORT=%PROJ%\tasks\logs\weekly_%TODAY%.txt

echo Weekly Analysis - %date% > "%REPORT%"
echo ========================================= >> "%REPORT%"

REM Use the claude.ai subscription, not pay-as-you-go API credit. With
REM ANTHROPIC_API_KEY set the CLI ignores the subscription entirely and bills API
REM credit - on 2026-08-03 that ran out and every agent died in seconds with
REM "Credit balance is too low". Cleared inside setlocal, so only this process.
set "ANTHROPIC_API_KEY="
pushd "%AGENTCWD%"
REM The prompt must NOT name %REPORT% as a file to write.
REM
REM This line redirects stdout into %REPORT% with >>, so cmd holds that file open for
REM the entire run. Asking the agent to "Append to %REPORT%" therefore asked it to
REM write to a file its own launcher had locked. On 2026-08-07 it spent ~20s and six
REM retries on Edit, Add-Content and bash >> before giving up and writing the review
REM to weekly_20260807_review.txt instead -- the analysis was fine, the delivery was
REM impossible. The redirect below is the whole delivery mechanism; the agent just
REM has to print.
REM Brief the agent before it works. On 2026-08-09 this review proposed a fix to
REM /api/trade-opened that was ALREADY IMPLEMENTED, more thoroughly than it asked
REM for -- sound reasoning, code-cited, and wasted, because it had no way to see
REM what it had proposed before or what was decided. It also emitted the same
REM finding three times across two files. The brief carries prior decisions, open
REM proposals, what is already measured, and the live config.
node "%PROJ%\tasks\ai_brief.cjs" --write >> "%REPORT%" 2>&1

REM CALL, not a bare invocation — see the same fix in auto_daily.bat. `claude` is
REM claude.cmd, and a .CMD run from a .BAT without CALL never returns, so every
REM line after this was dead: no [exit N] marker, no cleanup, no exit code of our
REM own. The scheduled task's result came from claude.cmd by accident, not design.
call claude -p "FIRST read %PROJ%\tasks\ai_brief.md in full - it lists what you have already proposed, what was decided, what is already measured, and the live config. Do NOT re-raise anything it marks as decided; if your finding matches one, say so in one line and move on. Weekly SmartEntry Pro review. Read %PROJ%\server\journal.json and consult http://localhost:3001/api/stats/by-setup. Print your review to standard output only - do NOT write, edit or append to any file, they are locked by this script. Cover: 1) Week trade summary - total trades, wins, losses, total P&L, win rate. 2) Best and worst performing asset. 3) Read avgRealizedR next to avgRR: a setup whose avgRR is high while avgRealizedR is negative is losing money on geometry that only looked good on paper - call that out. 4) One algorithm weakness supported by the trades actually in the journal; if there are too few closed trades to support any conclusion, say exactly that and stop rather than inventing one. 5) One specific proposed fix - which file, which function, what change, what evidence. Mark it clearly as PROPOSED FIX: so it can be found later. Do NOT edit source and do NOT commit. Max 40 lines." --dangerously-skip-permissions --output-format text --append-system-prompt "%NONINTERACTIVE%" --add-dir "%PROJ%" <nul >> "%REPORT%" 2>&1
set CLAUDE_RC=%ERRORLEVEL%
popd

REM msg.exe fails in a non-interactive session; never let it decide the exit code.
REM That is why this task reported FAILED(1) on 26/07 while its report was written.
msg * "SmartEntry Weekly Report ready. Check tasks\logs\ for the report and proposed improvement." >nul 2>&1

echo [exit %CLAUDE_RC%] >> "%REPORT%"
endlocal & exit /b %CLAUDE_RC%
