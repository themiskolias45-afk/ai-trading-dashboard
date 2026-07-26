@echo off
cd /d C:\Users\User\ai-trading-dashboard

if exist keys.env (
  for /f "usebackq tokens=1,* delims==" %%a in ("keys.env") do set "%%a=%%b"
)
if exist server\apikey.txt (
  set /p ANTHROPIC_API_KEY=<server\apikey.txt
)

cd server
node index.js >> C:\Users\User\ai-trading-dashboard\tasks\logs\server_log.txt 2>&1
