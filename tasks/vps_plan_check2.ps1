Set-Location 'C:\ai-trading-dashboard'
$u=$null;$p=$null
Get-Content 'keys.env' | ForEach-Object {
  if ($_ -match '^\s*DASHBOARD_USERNAME\s*=\s*(.+)$') { $u=$Matches[1].Trim() }
  if ($_ -match '^\s*DASHBOARD_PASSWORD\s*=\s*(.+)$') { $p=$Matches[1].Trim() }
}
$sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod 'http://localhost:3001/api/login' -Method Post -Body (@{username=$u;password=$p}|ConvertTo-Json) -ContentType 'application/json' -WebSession $sess -TimeoutSec 15 | Out-Null
$raw = Invoke-WebRequest 'http://localhost:3001/api/daily-plan' -WebSession $sess -TimeoutSec 40
Write-Output ('--- raw first 900 chars ---')
Write-Output ($raw.Content.Substring(0, [Math]::Min(900, $raw.Content.Length)))
Write-Output ('--- top-level keys ---')
($raw.Content | ConvertFrom-Json).PSObject.Properties.Name -join ', '
