@echo off
title SmartEntry Pro - Morning Routine
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
if not exist tasks\logs mkdir tasks\logs
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - MORNING ROUTINE
echo   %date% %time%
echo  ==========================================
echo.
echo  Fetching market data...

powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/prices | ConvertTo-Json -Depth 10 | Out-File tasks\temp\prices.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\prices.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\signals.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/risk-status | ConvertTo-Json -Depth 10 | Out-File tasks\temp\risk.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\risk.json -Encoding utf8 }"

echo  Done. Building report...
echo.

powershell -Command ^
  "$p = Get-Content tasks\temp\prices.json -Raw | ConvertFrom-Json;" ^
  "$s = Get-Content tasks\temp\signals.json -Raw | ConvertFrom-Json;" ^
  "$r = Get-Content tasks\temp\risk.json -Raw | ConvertFrom-Json;" ^
  "if ($p.error) { Write-Host '!! SERVER OFFLINE - start server first' -ForegroundColor Red; exit }" ^
  "Write-Host '';" ^
  "Write-Host '== PRICES ==' -ForegroundColor Cyan;" ^
  "Write-Host ('  BTC : $' + $p.btc + '  (' + $p.btcChange + '%)');" ^
  "Write-Host ('  Gold: $' + $p.gold + '  (' + $p.goldChange + '%)');" ^
  "Write-Host ('  SPY : $' + $p.spx + '  (' + $p.spxChange + '%)');" ^
  "Write-Host ('  DXY : ' + $p.dxy + '  |  VIX: ' + $p.vix);" ^
  "Write-Host '';" ^
  "Write-Host '== SIGNALS ==' -ForegroundColor Cyan;" ^
  "foreach ($key in @('btc','gold','spx')) {" ^
  "  $sig = $s.$key;" ^
  "  if ($sig -and $sig.signal) {" ^
  "    $conf = [int]$sig.confidence;" ^
  "    $flag = if ($conf -ge 65) { '[TRADE NOW]' } elseif ($conf -ge 40) { '[WATCH]' } else { '[WAIT]' };" ^
  "    $color = if ($conf -ge 65) { 'Green' } elseif ($conf -ge 40) { 'Yellow' } else { 'Gray' };" ^
  "    Write-Host ('  ' + $key.ToUpper() + ': ' + $sig.signal + ' | ' + $sig.setup + ' | conf:' + $conf + '% ' + $flag) -ForegroundColor $color;" ^
  "    if ($sig.entry) { Write-Host ('    Entry:$' + $sig.entry + ' Stop:$' + $sig.stop + ' Target:$' + $sig.target + ' RR:' + $sig.rr) };" ^
  "    if ($sig.reasons) { Write-Host ('    ' + $sig.reasons[0]) -ForegroundColor DarkGray };" ^
  "  }" ^
  "};" ^
  "Write-Host '';" ^
  "Write-Host '== RISK BUDGET ==' -ForegroundColor Cyan;" ^
  "Write-Host ('  Daily PnL: $' + $r.dailyPnl + '  |  Consecutive losses: ' + $r.consecutiveLosses + '/3');" ^
  "if ($r.halted) { Write-Host ('  !! HALTED: ' + $r.haltReason) -ForegroundColor Red } else { Write-Host '  Status: ACTIVE - safe to trade' -ForegroundColor Green };" ^
  "Write-Host '';" ^
  "Write-Host '== JOURNAL ==' -ForegroundColor Cyan;" ^
  "if (Test-Path server\journal.json) {" ^
  "  $j = Get-Content server\journal.json -Raw | ConvertFrom-Json;" ^
  "  $j | Select-Object -First 3 | ForEach-Object { Write-Host ('  ' + $_.direction + ' ' + $_.symbol + ' | ' + $_.status + ' | PnL: ' + $_.pnl) }" ^
  "} else { Write-Host '  No trades yet' -ForegroundColor DarkGray };" ^
  "Write-Host ''" 2>&1 | Tee-Object tasks\logs\morning_latest.txt

echo.
echo  ==========================================
echo   Report saved to tasks\logs\morning_latest.txt
echo  ==========================================
echo.
set /p AIASK=" Want AI commentary on this? (Y/N): "
if /i "%AIASK%"=="Y" (
  echo.
  echo  Running AI analysis...
  claude --dangerously-skip-permissions -p "JARVIS: Read tasks/logs/morning_latest.txt. Give a 5-line trading brief: market regime, best opportunity today, main risk, one key price level to watch, one-line verdict. Be specific with numbers." 2>&1
)
echo.
echo  Press any key to return to menu...
pause >nul
