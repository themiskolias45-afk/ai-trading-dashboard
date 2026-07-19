$log = [System.Collections.ArrayList]@()
function Out([string]$text, [string]$color = "") {
  $log.Add($text) | Out-Null
  if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

$p = Get-Content tasks\temp\prices.json -Raw | ConvertFrom-Json
$s = Get-Content tasks\temp\signals.json -Raw | ConvertFrom-Json
$r = Get-Content tasks\temp\risk.json -Raw | ConvertFrom-Json

if ($p.error) {
  Out "!! SERVER OFFLINE - start server first" "Red"
  exit
}

Out ""
Out "== PRICES ==" "Cyan"
Out ("  BTC : `$" + $p.btc + "  (" + $p.btcChange + "%)")
Out ("  Gold: `$" + $p.gold + "  (" + $p.goldChange + "%)")
Out ("  SPY : `$" + $p.spx + "  (" + $p.spxChange + "%)")
Out ("  DXY : " + $p.dxy + "  |  VIX: " + $p.vix)

Out ""
Out "== SIGNALS ==" "Cyan"
foreach ($key in @("btc","gold","spx")) {
  $sig = $s.$key
  if ($sig -and $sig.signal) {
    $conf = [int]$sig.confidence
    $flag  = if ($conf -ge 65) { "[TRADE NOW]" } elseif ($conf -ge 40) { "[WATCH]" } else { "[WAIT]" }
    $color = if ($conf -ge 65) { "Green" } elseif ($conf -ge 40) { "Yellow" } else { "Gray" }
    Out ("  " + $key.ToUpper() + ": " + $sig.signal + " | " + $sig.setup + " | conf:" + $conf + "% " + $flag) $color
    if ($sig.entry) { Out ("    Entry:`$" + $sig.entry + "  Stop:`$" + $sig.stop + "  Target:`$" + $sig.target + "  R:R:" + $sig.rr) }
    if ($sig.reasons -and $sig.reasons.Count -gt 0) { Out ("    " + $sig.reasons[0]) "DarkGray" }
    if ($sig.regime) { Out ("    Regime: " + $sig.regime + "  |  H4: " + $sig.h4.signal + "  |  Session: " + $sig.session.name) "DarkGray" }
  }
}

Out ""
Out "== RISK BUDGET ==" "Cyan"
Out ("  Daily PnL: `$" + $r.dailyPnl + "  |  Consecutive losses: " + $r.consecutiveLosses + "/3")
if ($r.halted) {
  Out ("  !! HALTED: " + $r.haltReason) "Red"
} else {
  Out "  Status: ACTIVE - safe to trade" "Green"
}

Out ""
Out "== JOURNAL ==" "Cyan"
if (Test-Path server\journal.json) {
  $j = Get-Content server\journal.json -Raw | ConvertFrom-Json
  $recent = $j | Select-Object -First 5
  foreach ($t in $recent) {
    $pnlColor = if ($t.pnl -gt 0) { "Green" } elseif ($t.pnl -lt 0) { "Red" } else { "Gray" }
    Out ("  " + $t.direction + " " + $t.symbol + " | " + $t.status + " | PnL: $" + $t.pnl) $pnlColor
  }
  $wins   = ($j | Where-Object { $_.pnl -gt 0 }).Count
  $total  = $j.Count
  if ($total -gt 0) {
    $wr = [math]::Round($wins / $total * 100, 0)
    Out ("  Win rate: " + $wr + "% (" + $wins + "/" + $total + " trades)") "Cyan"
  }
} else {
  Out "  No trades yet" "DarkGray"
}
Out ""
Out "===========================================" "DarkGray"
Out ("  Generated: " + (Get-Date -Format "yyyy-MM-dd HH:mm")) "DarkGray"
Out "===========================================" "DarkGray"
Out ""

# Save plain-text log (stripped of color info, just the text)
if (-not (Test-Path "tasks\logs")) { New-Item -ItemType Directory "tasks\logs" | Out-Null }
$log | Out-File "tasks\logs\morning_latest.txt" -Encoding utf8
