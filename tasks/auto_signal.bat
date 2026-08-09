@echo off
REM Runs via Task Scheduler - silent, logs to file only
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
if not exist tasks\logs mkdir tasks\logs

powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { exit 1 }"
if errorlevel 1 exit /b

REM Locale-independent stamp — see the note in tasks\auto_weekly.bat for the %date%
REM half. %time% had its own defect: before 10am it is " 9:05:00.00" with a LEADING
REM SPACE, so %time:~0,2% is " 9" and every filename written before 10am contained a
REM space -- "signals_20260708_ 905.txt". One format string fixes both.
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmm"') do set "STAMP=%%D"
set LOGFILE=tasks\logs\signals_%STAMP%.txt

call claude --dangerously-skip-permissions -p "JARVIS: Read tasks/temp/signals.json. If any asset has confidence >= 65, output: SIGNAL ALERT - [asset] [direction] [setup] conf:[N]%% entry:[price] stop:[price] target:[price] R:R:[N]. If nothing actionable, output: NO SIGNAL. One line only." > %LOGFILE% 2>&1

REM If an actionable signal was found, pop up a notification
findstr /i "SIGNAL ALERT" %LOGFILE% >nul
if not errorlevel 1 (
  for /f "delims=" %%a in (%LOGFILE%) do msg * "SmartEntry SIGNAL: %%a"
)
