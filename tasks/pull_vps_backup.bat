@echo off
setlocal enabledelayedexpansion
rem Pull the VPS's backups to this machine. This is the ONLY offsite copy of the box
rem that trades continuously, and it runs on the laptop because the VPS cannot reach
rem back here.
rem
rem It used to fetch "Select-Object -First 1" - the single newest zip. So every day the
rem laptop was asleep became a PERMANENT hole in the chain: on 2026-08-21 the pull log
rem jumped 08-19 -> 08-21 and backup_20260820 was simply never collected, even though
rem the VPS had made it on schedule. The VPS keeps 14 days, so a laptop outage longer
rem than that would lose those days for good. Now it pulls everything it is missing.
set KEY=C:\Users\User\.ssh\contabo_smartentry
set VPS=administrator@169.58.74.133
set DEST=C:\Users\User\ai-trading-dashboard\vps-backups

if not exist "%DEST%" mkdir "%DEST%"

ssh -i "%KEY%" %VPS% "powershell -Command Get-ChildItem C:\ai-trading-dashboard-backups\*.zip ^| Sort-Object LastWriteTime ^| Select-Object -ExpandProperty Name" > "%DEST%\remote_names.txt" 2>>"%DEST%\pull_errors.txt"

set PULLED=0
set MISSING=0
for /f "usebackq delims=" %%F in ("%DEST%\remote_names.txt") do (
  set "NAME=%%F"
  if not "!NAME!"=="" (
    if not exist "%DEST%\!NAME!" (
      set /a MISSING+=1
      scp -i "%KEY%" "%VPS%:/C:/ai-trading-dashboard-backups/!NAME!" "%DEST%\!NAME!" 2>>"%DEST%\pull_errors.txt"
      if exist "%DEST%\!NAME!" (
        set /a PULLED+=1
        echo [%date% %time%] Pulled !NAME! from VPS >> "%DEST%\pull_log.txt"
      ) else (
        echo [%date% %time%] FAILED to pull !NAME! >> "%DEST%\pull_log.txt"
      )
    )
  )
)

if "%MISSING%"=="0" (
  echo [%date% %time%] Up to date - nothing missing >> "%DEST%\pull_log.txt"
) else (
  echo [%date% %time%] Catch-up complete - %PULLED% of %MISSING% missing backups pulled >> "%DEST%\pull_log.txt"
)

rem Keep more than the VPS does, so this copy outlives the source.
powershell -Command "Get-ChildItem '%DEST%\*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 21 | Remove-Item -Force"
endlocal
