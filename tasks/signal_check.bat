@echo off
title SmartEntry Pro - Signal Check
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
cls
echo.
echo  ==========================================
echo   SmartEntry Pro - LIVE SIGNALS
echo   %time%
echo  ==========================================
echo.

powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/signals | ConvertTo-Json -Depth 10 | Out-File tasks\temp\signals.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\signals.json -Encoding utf8 }"
powershell -Command "try { Invoke-RestMethod http://localhost:3001/api/prices | ConvertTo-Json -Depth 10 | Out-File tasks\temp\prices.json -Encoding utf8 } catch { '{\"error\":\"offline\"}' | Out-File tasks\temp\prices.json -Encoding utf8 }"

powershell -Command ^
  "$s = Get-Content tasks\temp\signals.json -Raw | ConvertFrom-Json;" ^
  "$p = Get-Content tasks\temp\prices.json -Raw | ConvertFrom-Json;" ^
  "if ($s.error) { Write-Host 'SERVER OFFLINE' -ForegroundColor Red; exit };" ^
  "Write-Host ('{0,-6} {1,-6} {2,-22} {3,-8} {4,-10} {5,-10} {6,-10} {7}' -f 'ASSET','SIGNAL','SETUP','CONF','ENTRY','STOP','TARGET','STATUS');" ^
  "Write-Host ('-' * 85);" ^
  "foreach ($key in @('btc','gold','spx')) {" ^
  "  $sig = $s.$key;" ^
  "  if ($sig -and $sig.signal) {" ^
  "    $conf = [int]$sig.confidence;" ^
  "    $flag = if ($conf -ge 65) { '[TRADE NOW]' } elseif ($conf -ge 40) { '[WATCH]' } else { '[WAIT]' };" ^
  "    $color = if ($conf -ge 65) { 'Green' } elseif ($conf -ge 40) { 'Yellow' } else { 'Gray' };" ^
  "    $line = '{0,-6} {1,-6} {2,-22} {3,-8} {4,-10} {5,-10} {6,-10} {7}' -f $key.ToUpper(), $sig.signal, $sig.setup, ($conf+'%'), $sig.entry, $sig.stop, $sig.target, $flag;" ^
  "    Write-Host $line -ForegroundColor $color" ^
  "  }" ^
  "};" ^
  "Write-Host ''"

echo.
pause
