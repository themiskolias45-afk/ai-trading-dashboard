# Lifts the trading halt via the dashboard session. POST /api/mt5/control is
# read-open but write-protected, so a session cookie is required; credentials are
# read from keys.env on this machine and never printed.
$ErrorActionPreference = 'Continue'

$kv = @{}
Get-Content 'C:\ai-trading-dashboard\keys.env' | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { $kv[$matches[1].Trim()] = $matches[2].Trim() }
}

$loginBody = @{ username = $kv['DASHBOARD_USERNAME']; password = $kv['DASHBOARD_PASSWORD'] } | ConvertTo-Json
try {
  $login = Invoke-WebRequest -Uri 'http://localhost:3001/api/login' -Method Post `
    -Body $loginBody -ContentType 'application/json' -SessionVariable sess `
    -UseBasicParsing -TimeoutSec 15
  Write-Output ("login HTTP " + $login.StatusCode)
} catch {
  Write-Output ("login failed: " + $_.Exception.Message); exit 1
}

$unhaltBody = @{ halted = $false; reason = ''; setBy = 'jarvis' } | ConvertTo-Json
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3001/api/mt5/control' -Method Post `
    -Body $unhaltBody -ContentType 'application/json' -WebSession $sess `
    -UseBasicParsing -TimeoutSec 15
  Write-Output ("unhalt HTTP " + $r.StatusCode)
} catch {
  Write-Output ("unhalt failed: " + $_.Exception.Message); exit 1
}

$c = (Invoke-WebRequest -Uri 'http://localhost:3001/api/mt5/control' -UseBasicParsing -TimeoutSec 10).Content
Write-Output ("control now: " + $c)
Write-Output ("file now:    " + ((Get-Content 'C:\ai-trading-dashboard\server\trading_control.json' -Raw) -replace "`r`n",' '))
