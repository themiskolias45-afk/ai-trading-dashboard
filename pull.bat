@echo off
cd /d "C:\Users\User\ai-trading-dashboard"

REM Auto-commit any local changes before pulling
git add -A >nul 2>&1
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Auto-save local changes before pull" >nul 2>&1
  echo  Local changes saved.
)

REM Pull from remote
echo  Pulling latest updates...
git pull --no-edit origin claude/backup-deploy-server-FWgpv

echo.
echo  Done. Restart server if needed.
echo.
pause
