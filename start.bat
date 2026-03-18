@echo off
title Smart Entry Pro — Launcher
color 0B
echo.
echo  ============================================
echo   SMART ENTRY PRO V3 — STARTING...
echo  ============================================
echo.

:: ── Check Node.js ──────────────────────────────
node --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js not found.
    echo  Run setup.bat first, or download Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: ── Check node_modules ─────────────────────────
if not exist "node_modules" (
    echo  [INFO] node_modules not found — running npm install first...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        color 0C
        echo  [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

echo  [OK] Dependencies ready.
echo.

:: ── Start Backend in new window ─────────────────
echo  Starting backend signal engine on port 4000...
start "SEP Backend - Signal Engine" cmd /k "color 0A && echo  SMART ENTRY PRO — BACKEND ENGINE && echo  Press Ctrl+C to stop && echo. && npm run backend"

:: ── Wait 2 seconds for backend to initialise ───
echo  Waiting for backend to start...
timeout /t 2 /nobreak >nul

:: ── Start Frontend in new window ───────────────
echo  Starting dashboard on port 5173...
start "SEP Frontend - Dashboard" cmd /k "color 0B && echo  SMART ENTRY PRO — DASHBOARD && echo  Open: http://localhost:5173 && echo. && npm run dev"

:: ── Wait for Vite to start ─────────────────────
echo  Waiting for dashboard to be ready...
timeout /t 3 /nobreak >nul

:: ── Open browser ───────────────────────────────
echo  Opening dashboard in browser...
start http://localhost:5173

echo.
echo  ============================================
echo   SMART ENTRY PRO V3 IS RUNNING
echo  ============================================
echo.
echo  Dashboard  : http://localhost:5173
echo  API        : http://localhost:4000/api/signals
echo  Log        : http://localhost:4000/api/log
echo  Stats      : http://localhost:4000/api/stats
echo.
echo  Two windows have opened:
echo   - GREEN window  = Backend signal engine
echo   - BLUE window   = Frontend dashboard
echo.
echo  To stop: close both windows, or press Ctrl+C in each.
echo.
echo  This window can be closed.
pause
