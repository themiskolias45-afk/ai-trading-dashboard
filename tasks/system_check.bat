@echo off
title SmartEntry Pro - System Health Check
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - SYSTEM HEALTH CHECK
echo  ==========================================
echo.

REM ── 1. Node server ───────────────────────────────────────────
echo  Checking server...
powershell -Command "try { $r = Invoke-RestMethod http://localhost:3001/api/prices -TimeoutSec 5; '[OK] Server : ONLINE' } catch { '[!!] Server : OFFLINE - run option 8 to restart' }"

REM ── 2. Signals generating ────────────────────────────────────
echo  Checking signals...
powershell -Command "try { $r = Invoke-RestMethod http://localhost:3001/api/signals -TimeoutSec 5; $r | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8; if ($r.btc -or $r.signals) { '[OK] Signals : GENERATING' } else { '[!!] Signals : NOT GENERATING' } } catch { '[!!] Signals : CANNOT REACH SERVER' }"

REM ── 3. Risk system ───────────────────────────────────────────
echo  Checking risk system...
powershell -Command "try { $r = Invoke-RestMethod http://localhost:3001/api/risk-status -TimeoutSec 5; $r | ConvertTo-Json -Depth 10 | Out-File tasks\temp\risk.json -Encoding utf8; if ($r.halted) { '[!!] Risk    : HALTED - ' + $r.haltReason } else { '[OK] Risk    : ACTIVE (daily PnL: $' + $r.dailyPnl + ', losses: ' + $r.consecutiveLosses + ')' } } catch { '[!!] Risk    : CANNOT REACH SERVER' }"

REM ── 4. MT5 positions endpoint ────────────────────────────────
echo  Checking MT5 bridge...
powershell -Command "try { $r = Invoke-RestMethod http://localhost:3001/api/mt5/positions -TimeoutSec 5; $r | ConvertTo-Json -Depth 10 | Out-File tasks\temp\positions.json -Encoding utf8; '[OK] MT5     : BRIDGE CONNECTED (' + $r.Count + ' open positions)' } catch { '[!!] MT5     : BRIDGE OFFLINE - run mt5_bridge.py' }"

REM ── 5. Node process ──────────────────────────────────────────
echo  Checking processes...
tasklist /fi "imagename eq node.exe" /fo csv /nh 2>nul | findstr /i "node" >nul
if not errorlevel 1 (echo  [OK] Process: node.exe is RUNNING) else (echo  [!!] Process: node.exe NOT FOUND)

tasklist /fi "imagename eq python.exe" /fo csv /nh 2>nul | findstr /i "python" >nul
if not errorlevel 1 (echo  [OK] Process: python.exe is RUNNING) else (echo  [!!] Process: python.exe NOT FOUND - MT5 bridge may be down)

REM ── 6. Journal file ──────────────────────────────────────────
if exist server\journal.json (
  for %%A in (server\journal.json) do echo  [OK] Journal : EXISTS (%%~zA bytes)
) else (
  echo  [--] Journal : No trades yet (file created on first trade)
)

REM ── 7. API key ───────────────────────────────────────────────
if exist server\apikey.txt (
  echo  [OK] API Key : Found in server\apikey.txt
) else (
  echo  [!!] API Key : MISSING - server\apikey.txt not found
)

echo.
echo  ==========================================
echo  Claude deep analysis...
echo  ==========================================
echo.

call claude --dangerously-skip-permissions -p "JARVIS: Read tasks/temp/signals.json, tasks/temp/risk.json, tasks/temp/positions.json (all may or may not exist). Give a 5-line system health summary: 1) Overall verdict: HEALTHY / DEGRADED / OFFLINE. 2) Signal quality: are BTC/Gold/SPY all showing valid data? 3) Risk system status. 4) MT5 connection status. 5) One action item if anything is wrong. If files are missing, say which component is down."

echo.
echo  ==========================================
echo.
pause
