@echo off
title Smart Entry Pro — Setup
color 0B
echo.
echo  ============================================
echo   SMART ENTRY PRO — FIRST TIME SETUP
echo  ============================================
echo.

:: ── Check Git ──────────────────────────────────
git --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Git is not installed.
    echo.
    echo  Download and install Git from:
    echo  https://git-scm.com/download/win
    echo.
    echo  After installing, close this window and run setup.bat again.
    pause
    exit /b 1
)
echo  [OK] Git found.

:: ── Check Node.js ──────────────────────────────
node --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js is not installed.
    echo.
    echo  Download and install Node.js (LTS) from:
    echo  https://nodejs.org
    echo.
    echo  After installing, close this window and run setup.bat again.
    pause
    exit /b 1
)
echo  [OK] Node.js found.

:: ── Check npm ──────────────────────────────────
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] npm not found. Reinstall Node.js from https://nodejs.org
    pause
    exit /b 1
)
echo  [OK] npm found.

echo.
echo  ── Installing dependencies ──────────────────
echo.
call npm install
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo  [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
)

echo.
echo  ============================================
echo   SETUP COMPLETE!
echo  ============================================
echo.
echo  Now run:  start.bat
echo.
pause
