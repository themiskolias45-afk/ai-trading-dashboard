@echo off
cd /d "C:\Users\User\ai-trading-dashboard"
echo Pulling latest updates...
git stash >nul 2>&1
git pull --no-edit origin claude/backup-deploy-server-FWgpv
git stash pop >nul 2>&1
echo.
echo Done. Restart server if server/index.js changed.
echo.
pause
