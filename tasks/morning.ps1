$p = Get-Content tasks\temp\prices.json -Raw | ConvertFrom-Json
$s = Get-Content tasks\temp\signals.json -Raw | ConvertFrom-Json
$r = Get-Content tasks\temp\risk.json -Raw | ConvertFrom-Json

if ($p.error) {
  Write-Host "!! SERVER OFFLINE - start server first" -ForegroundColor Red
  exit
}

Write-Host ""
Write-Host "== PRICES ==" -ForegroundColor Cyan
Write-Host ("  BTC : `$" + $p.btc + "  (" + $p.btcChange + "%)")
Write-Host ("  Gold: `$" + $p.gold + "  (" + $p.goldChange + "%)")
Write-Host ("  SPY : `$" + $p.spx + "  (" + $p.spxChange + "%)")
Write-Host ("  DXY : " + $p.dxy + "  |  VIX: " + $p.vix)

Write-Host ""
Write-Host "== SIGNALS ==" -ForegroundColor Cyan
foreach ($key in @("btc","gold","spx")) {
  $sig = $s.$key
  if ($sig -and $sig.signal) {
    $conf = [int]$sig.confidence
    $flag  = if ($conf -ge 65) { "[TRADE NOW]" } elseif ($conf -ge 40) { "[WATCH]" } else { "[WAIT]" }
    $color = if ($conf -ge 65) { "Green" } elseif ($conf -ge 40) { "Yellow" } else { "Gray" }
    Write-Host ("  " + $key.ToUpper() + ": " + $sig.signal + " | " + $sig.setup + " | conf:" + $conf + "% " + $flag) -ForegroundColor $color
    if ($sig.entry) { Write-Host ("    Entry:`$" + $sig.entry + "  Stop:`$" + $sig.stop + "  Target:`$" + $sig.target + "  R:R:" + $sig.rr) }
    if ($sig.reasons -and $sig.reasons.Count -gt 0) { Write-Host ("    " + $sig.reasons[0]) -ForegroundColor DarkGray }
  }
}

Write-Host ""
Write-Host "== RISK BUDGET ==" -ForegroundColor Cyan
Write-Host ("  Daily PnL: `$" + $r.dailyPnl + "  |  Consecutive losses: " + $r.consecutiveLosses + "/3")
if ($r.halted) {
  Write-Host ("  !! HALTED: " + $r.haltReason) -ForegroundColor Red
} else {
  Write-Host "  Status: ACTIVE - safe to trade" -ForegroundColor Green
}

Write-Host ""
Write-Host "== JOURNAL ==" -ForegroundColor Cyan
if (Test-Path server\journal.json) {
  $j = Get-Content server\journal.json -Raw | ConvertFrom-Json
  $j | Select-Object -First 3 | ForEach-Object {
    Write-Host ("  " + $_.direction + " " + $_.symbol + " | " + $_.status + " | PnL: " + $_.pnl)
  }
} else {
  Write-Host "  No trades yet" -ForegroundColor DarkGray
}
Write-Host ""
