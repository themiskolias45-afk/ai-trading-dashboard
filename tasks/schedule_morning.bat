@echo off
title Schedule JARVIS Morning Agent
echo.
echo  Setting up JARVIS morning agent to run automatically at 7:00 AM daily...
echo.

REM Delete existing task if present
schtasks /delete /tn "JARVIS Morning Agent" /f >nul 2>&1

REM Create new scheduled task
schtasks /create /tn "JARVIS Morning Agent" /tr "C:\Users\User\ai-trading-dashboard\tasks\morning_agent.bat" /sc DAILY /st 07:00 /ru "%USERNAME%" /f

if errorlevel 1 (
  echo  ERROR: Could not create scheduled task. Run this as Administrator.
  pause
  exit /b 1
)

echo.
echo  SUCCESS. JARVIS will now run automatically every day at 7:00 AM.
echo.
echo  What it does automatically:
echo   - Checks server health and signals
echo   - Finds any setup with poor win rate
echo   - Implements improvements if safe
echo   - Writes summary to tasks\logs\morning_summary.txt
echo.
echo  To view logs:     type tasks\logs\morning_summary.txt
echo  To disable:       schtasks /delete /tn "JARVIS Morning Agent" /f
echo  To run manually:  tasks\morning_agent.bat
echo.
pause
