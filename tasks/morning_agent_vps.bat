@echo off
REM JARVIS autonomous morning cycle — VPS version.
REM
REM This ran only on the local PC, which is off most of the time, so the daily
REM improvement loop fired only when someone happened to be at the keyboard. The
REM VPS runs 24/7 and is where the system actually lives, so it belongs here.
REM
REM Requires the claude CLI (installed on the VPS 2026-07-26) and the Anthropic
REM key, which is read from server\apikey.txt the same way start_server_vps.bat
REM does it — a Scheduled Task gets no inherited environment.

cd /d C:\ai-trading-dashboard
if not exist tasks\logs mkdir tasks\logs

if exist keys.env (
  for /f "usebackq tokens=1,* delims==" %%a in ("keys.env") do set "%%a=%%b"
)
if exist server\apikey.txt set /p ANTHROPIC_API_KEY=<server\apikey.txt

echo [%date% %time%] JARVIS morning agent starting (VPS)... >> tasks\logs\agent_log.txt

claude --dangerously-skip-permissions -p "You are JARVIS, SmartEntry Pro trading system engineer, running unattended on the VPS. Run a full autonomous morning cycle: 1) Fetch http://localhost:3001/api/checksystem and note any problems. 2) Fetch http://localhost:3001/api/signals - list any signals with confidence >= 65%%. 3) Fetch http://localhost:3001/api/learning - report setupStats; if any setup has WR < 40%% over 5+ trades, say so. 4) Fetch http://localhost:3001/api/strategy-settings and report the live limits. 5) Write a summary to tasks/logs/morning_summary.txt: date, signals found, learning state, system status. One paragraph, no fluff. DO NOT edit source code or commit - report only." >> tasks\logs\agent_log.txt 2>&1

echo [%date% %time%] JARVIS morning agent complete. >> tasks\logs\agent_log.txt
