@echo off
set KEY=C:\Users\User\.ssh\contabo_smartentry
set VPS=administrator@169.58.74.133
set DEST=C:\Users\User\ai-trading-dashboard\vps-backups

if not exist "%DEST%" mkdir "%DEST%"

ssh -i "%KEY%" %VPS% "powershell -Command Get-ChildItem C:\ai-trading-dashboard-backups\*.zip ^| Sort-Object LastWriteTime -Descending ^| Select-Object -First 1 -ExpandProperty Name" > "%DEST%\latest_name.txt" 2>>"%DEST%\pull_errors.txt"

set /p LATEST=<"%DEST%\latest_name.txt"

if "%LATEST%"=="" (
  echo [%date% %time%] No backup found on VPS to pull >> "%DEST%\pull_log.txt"
  goto :eof
)

scp -i "%KEY%" "%VPS%:/C:/ai-trading-dashboard-backups/%LATEST%" "%DEST%\%LATEST%" 2>>"%DEST%\pull_errors.txt"

if exist "%DEST%\%LATEST%" (
  echo [%date% %time%] Pulled %LATEST% from VPS >> "%DEST%\pull_log.txt"
) else (
  echo [%date% %time%] FAILED to pull %LATEST% >> "%DEST%\pull_log.txt"
)

powershell -Command "Get-ChildItem '%DEST%\*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Force"
