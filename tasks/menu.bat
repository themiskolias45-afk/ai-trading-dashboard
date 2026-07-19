@echo off
:MENU
title SmartEntry Pro - Command Center
cd /d "C:\Users\User\ai-trading-dashboard"
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - COMMAND CENTER
echo  ==========================================
echo.
echo   [1] System check        (is everything running?)
echo   [2] Signal check        (live signals right now)
echo   [3] Risk check          (SAFE / CAUTION / HALT)
echo   [4] Daily check         (signals + journal + risk)
echo   [5] Journal review      (win rate + PnL breakdown)
echo   [6] Backtest            (run fresh backtest)
echo   [7] Improve algorithm   (analyse + approve + apply)
echo   [8] Install auto-tasks  (set up Task Scheduler)
echo   [S] Start server        (restart node server)
echo   [9] Exit
echo.
set /p CHOICE=" Choose (1-9): "

if "%CHOICE%"=="1" call tasks\system_check.bat   && goto MENU
if "%CHOICE%"=="2" call tasks\signal_check.bat   && goto MENU
if "%CHOICE%"=="3" call tasks\risk_check.bat     && goto MENU
if "%CHOICE%"=="4" call tasks\daily_check.bat    && goto MENU
if "%CHOICE%"=="5" call tasks\journal_review.bat && goto MENU
if "%CHOICE%"=="6" call tasks\backtest_run.bat   && goto MENU
if "%CHOICE%"=="7" call tasks\improve_algo.bat   && goto MENU
if "%CHOICE%"=="8" call tasks\install_schedule.bat && goto MENU
if /i "%CHOICE%"=="S" (
  taskkill /F /IM node.exe /T >nul 2>&1
  start "SmartEntry Server" cmd /k "cd /d C:\Users\User\ai-trading-dashboard\server && node index.js"
  echo  Server restarting...
  timeout /t 3 /nobreak >nul
  goto MENU
)
if "%CHOICE%"=="9" exit
goto MENU
