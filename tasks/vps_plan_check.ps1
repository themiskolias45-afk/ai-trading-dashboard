Set-Location 'C:\ai-trading-dashboard'
$env:PATH = $env:PATH
$u = $null; $p = $null
Get-Content 'keys.env' | ForEach-Object {
  if ($_ -match '^\s*DASHBOARD_USERNAME\s*=\s*(.+)$') { $u = $Matches[1].Trim() }
  if ($_ -match '^\s*DASHBOARD_PASSWORD\s*=\s*(.+)$') { $p = $Matches[1].Trim() }
}
if (-not $u -or -not $p) { Write-Output 'NO CREDENTIALS IN keys.env'; exit 1 }
Write-Output 'credentials loaded from keys.env (not printed)'
$sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod 'http://localhost:3001/api/login' -Method Post -Body (@{username=$u;password=$p}|ConvertTo-Json) -ContentType 'application/json' -WebSession $sess -TimeoutSec 15 | Out-Null
$plan = Invoke-RestMethod 'http://localhost:3001/api/daily-plan' -WebSession $sess -TimeoutSec 30
Write-Output "VPS regime: $($plan.regime)"
Write-Output 'VPS rules:'
foreach ($r in $plan.rules) { Write-Output "  - $r" }
