# Forces a signal refresh on the local SmartEntry server using the dashboard
# session. POST /api/plan/refresh is not in the no-login allowlist, so a session
# cookie is required; credentials are read from keys.env on this machine and are
# never printed.
$ErrorActionPreference = 'Continue'

$kv = @{}
Get-Content 'C:\ai-trading-dashboard\keys.env' | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { $kv[$matches[1].Trim()] = $matches[2].Trim() }
}

if (-not $kv['DASHBOARD_USERNAME'] -or -not $kv['DASHBOARD_PASSWORD']) {
  Write-Output 'keys.env is missing DASHBOARD_USERNAME or DASHBOARD_PASSWORD'
  exit 1
}

$body = @{ username = $kv['DASHBOARD_USERNAME']; password = $kv['DASHBOARD_PASSWORD'] } | ConvertTo-Json

try {
  $login = Invoke-WebRequest -Uri 'http://localhost:3001/api/login' `
    -Method Post -Body $body -ContentType 'application/json' `
    -SessionVariable sess -UseBasicParsing -TimeoutSec 15
  Write-Output ("login HTTP " + $login.StatusCode)
} catch {
  Write-Output ("login failed: " + $_.Exception.Message)
  exit 1
}

try {
  $refresh = Invoke-WebRequest -Uri 'http://localhost:3001/api/plan/refresh' `
    -Method Post -WebSession $sess -UseBasicParsing -TimeoutSec 240
  Write-Output ("refresh HTTP " + $refresh.StatusCode)
} catch {
  Write-Output ("refresh failed: " + $_.Exception.Message)
  exit 1
}

$signals = (Invoke-WebRequest -Uri 'http://localhost:3001/api/signals' -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
Write-Output ''
Write-Output ("updatedAt = " + $signals.updatedAt)
foreach ($k in @('btc','gold','spx')) {
  $x = $signals.$k
  Write-Output ("{0,-5} {1,-4} conf={2,-3} str={3,-9} src={4}/{5} px={6} entry={7} stop={8} target={9} volRatio={10}" -f `
    $k, $x.signal, $x.confidence, $x.strength, $x.dataSource, $x.sourceSymbol, `
    [math]::Round($x.price,2), $x.entry, $x.stop, $x.target, $x.volume.ratio)
}
