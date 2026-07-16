@echo off
cd /d "%~dp0"
for /f "tokens=1,* delims==" %%a in (keys.env) do set "%%a=%%b"
cd /d "%~dp0server"
node index.js
