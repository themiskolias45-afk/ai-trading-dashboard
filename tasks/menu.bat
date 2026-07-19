@echo off
:MENU
title SmartEntry Pro - Command Center
cd /d "C:\Users\User\ai-trading-dashboard"
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - COMMAND CENTER
echo   %date%  %time%
echo  ==========================================
echo.
echo   -- DAILY TASKS (run in order) ----------
echo   [1] Morning routine     (full brief: prices+signals+plan)
echo   [2] Signal check        (live signals right now)
echo   [3] Diagnose            (why are signals blocked?)
echo   [4] Risk check          (SAFE / CAUTION / HALT)
echo   [5] Evening report      (end of day review + save)
echo.
echo   -- SYSTEM TASKS -------------------------
echo   [6] System check        (is everything running?)
echo   [7] Journal review      (win rate + PnL breakdown)
echo   [8] Improve algorithm   (analyse + approve + apply)
echo   [9] Backtest            (run fresh backtest)
echo   [W] Weekly optimize     (Sunday strategy review)
echo.
echo   -- CONTROLS -----------------------------
echo   [S] Start server        (restart node server)
echo   [I] Install auto-tasks  (set up Task Scheduler)
echo   [0] Exit
echo.
set /p CHOICE=" Choose: "
echo.

if "%CHOICE%"=="1" call tasks\morning_routine.bat  && goto MENU
if "%CHOICE%"=="2" call tasks\signal_check.bat     && goto MENU
if "%CHOICE%"=="3" call tasks\diagnose.bat         && goto MENU
if "%CHOICE%"=="4" call tasks\risk_check.bat       && goto MENU
if "%CHOICE%"=="5" call tasks\evening_report.bat   && goto MENU
if "%CHOICE%"=="6" call tasks\system_check.bat     && goto MENU
if "%CHOICE%"=="7" call tasks\journal_review.bat   && goto MENU
if "%CHOICE%"=="8" call tasks\improve_algo.bat     && goto MENU
if "%CHOICE%"=="9" call tasks\backtest_run.bat     && goto MENU
if /i "%CHOICE%"=="W" call tasks\weekly_optimize.bat && goto MENU
if /i "%CHOICE%"=="I" call tasks\install_schedule.bat && goto MENU
if /i "%CHOICE%"=="S" (
  taskkill /F /IM node.exe /T >nul 2>&1
  start "SmartEntry Server" cmd /k "cd /d C:\Users\User\ai-trading-dashboard\server && node index.js"
  echo  Server restarting...
  timeout /t 4 /nobreak >nul
  goto MENU
)
if "%CHOICE%"=="0" exit
goto MENU
