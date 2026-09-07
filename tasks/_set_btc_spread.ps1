# Sets the per-symbol BTC spread cap in the VPS bridge launcher.
#
# Written with explicit CRLF: a .bat saved with bare LF is parsed as one broken
# line by cmd and silently does nothing, which would take the bridge down without
# an error anywhere.

$ErrorActionPreference = 'Stop'
$bat = 'C:\ai-trading-dashboard\tasks\start_bridge_A_vps.bat'

$raw = [System.IO.File]::ReadAllText($bat)

if ($raw -match 'MAX_SPREAD_BTCUSD') {
    Write-Output 'MAX_SPREAD_BTCUSD already present - no change'
    exit 0
}

$anchor = 'set BRIDGE_LOG=tasks\logs\bridge_log_A.txt'
if ($raw -notmatch [regex]::Escape($anchor)) {
    Write-Output 'ABORT - anchor line not found, refusing to guess where to insert'
    exit 1
}

# Vantage quotes BTCUSD with a ~$17 spread, which the bridge measures as ~1700
# ticks against a global cap of 50 - so BTC was rejected 100% of the time before
# an order was ever sent. 2500 leaves headroom over the observed 1700-1710 band
# while still refusing a genuinely blown-out book.
$insert = $anchor + "`r`n" +
          "`r`n" +
          "REM Per-symbol spread cap. Vantage quotes BTCUSD with a ~`$17 spread, which the`r`n" +
          "REM bridge measures as ~1700 ticks - against the global cap of 50 that rejected`r`n" +
          "REM every BTC trade before an order was sent, and read as 'no signal' in the logs.`r`n" +
          "REM Gold (22) and SP500 (36) stay on the global cap and are unaffected.`r`n" +
          "set MAX_SPREAD_BTCUSD=2500"

$raw = $raw.Replace($anchor, $insert)
[System.IO.File]::WriteAllText($bat, $raw, (New-Object System.Text.UTF8Encoding($false)))

Write-Output 'inserted MAX_SPREAD_BTCUSD=2500'
Write-Output '--- verify ---'
Get-Content $bat | Select-String -Pattern 'set ' | ForEach-Object { '  ' + $_.Line }
