@echo off
cd /d "%~dp0"

REM Load API keys from keys.env if it exists
if exist "%~dp0keys.env" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0keys.env") do (
    if not "%%a"=="" if not "%%a:~0,1%"=="#" set "%%a=%%b"
  )
)

cd /d "%~dp0server"
node index.js
