@echo off
cd /d C:\Users\User\ai-trading-dashboard

REM Create backup folder with today's date
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set BACKUP_DIR=tasks\backups\%DT:~0,8%

if not exist %BACKUP_DIR% mkdir %BACKUP_DIR%

REM Backup critical data files
if exist server\journal.json     copy /Y server\journal.json     %BACKUP_DIR%\journal.json     >nul
if exist server\learning.json    copy /Y server\learning.json    %BACKUP_DIR%\learning.json    >nul
if exist server\journal.json     copy /Y server\journal.json     tasks\backups\journal_latest.json >nul
if exist server\learning.json    copy /Y server\learning.json    tasks\backups\learning_latest.json >nul

echo [%date% %time%] Backup saved to %BACKUP_DIR% >> tasks\logs\backup_log.txt
