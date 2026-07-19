@echo off
REM Runs via Task Scheduler - silent, logs to file only
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
if not exist tasks\logs mkdir tasks\logs

powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { exit 1 }"
if errorlevel 1 exit /b

set LOGFILE=tasks\logs\signals_%date:~-4,4%%date:~-10,2%%date:~-7,2%_%time:~0,2%%time:~3,2%.txt

claude --dangerously-skip-permissions -p "JARVIS: Read tasks/temp/signals.json. If any asset has confidence >= 65, output: SIGNAL ALERT - [asset] [direction] [setup] conf:[N]%% entry:[price] stop:[price] target:[price] R:R:[N]. If nothing actionable, output: NO SIGNAL. One line only." > %LOGFILE% 2>&1

REM If an actionable signal was found, pop up a notification
findstr /i "SIGNAL ALERT" %LOGFILE% >nul
if not errorlevel 1 (
  for /f "delims=" %%a in (%LOGFILE%) do msg * "SmartEntry SIGNAL: %%a"
)
