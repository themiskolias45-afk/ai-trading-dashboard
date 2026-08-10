@echo off
REM Resume any agent brief parked by a claude.ai session limit.
REM
REM Path-relative via %~dp0 so ONE file works on both boxes: the laptop checkout is
REM C:\Users\User\ai-trading-dashboard and the VPS is C:\ai-trading-dashboard.
REM Hardcoding either is how tasks/ ended up with _vps twins of half its scripts.
REM
REM Cheap when the queue is empty - it prints one line and exits, so running this
REM hourly costs nothing. claude_agent.py strips ANTHROPIC_API_KEY itself, so this
REM deliberately does NOT load keys.env: the drain must bill the subscription, and
REM loading the key would send it to pay-as-you-go credit instead.
cd /d "%~dp0.."
if not exist "%~dp0logs" mkdir "%~dp0logs"
echo [%date% %time%] drain start>> "%~dp0logs\agent_drain.txt"
python claude_agent.py drain>> "%~dp0logs\agent_drain.txt" 2>&1

REM Completion marker. Without it the ledger cannot tell a run that finished from
REM one that was killed mid-drain, and this job has read NO COMPLETION MARKER on
REM both boxes since it was created while the scheduler recorded rc=0 throughout.
set DRAIN_RC=%ERRORLEVEL%
echo [exit %DRAIN_RC%]>> "%~dp0logs\agent_drain.txt"
exit /b %DRAIN_RC%
