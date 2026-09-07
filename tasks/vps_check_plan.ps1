Set-Location 'C:\ai-trading-dashboard'
Write-Output '--- scheduled tasks matching SmartEntry ---'
schtasks /Query /FO CSV /NH 2>$null | ForEach-Object { $f=$_ -split '","'; if ($f[0] -match 'SmartEntry|Ensure') { Write-Output ("  " + ($f[0] -replace '"','')) } }
Write-Output '--- server identity ---'
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
foreach ($n in $p) { Write-Output ("  PID {0} started {1}" -f $n.ProcessId, $n.CreationDate) }
try { $st = Invoke-RestMethod 'http://localhost:3001/api/status' -TimeoutSec 10; Write-Output "  startedAt $($st.startedAt)" } catch { Write-Output "  status err $($_.Exception.Message)" }
Write-Output '--- does the RUNNING server have the new rules? ---'
$sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
  $key = (Get-Content 'server\apikey.txt' -Raw).Trim()
  Invoke-RestMethod 'http://localhost:3001/api/login' -Method Post -Body (@{password=$key}|ConvertTo-Json) -ContentType 'application/json' -WebSession $sess -TimeoutSec 10 | Out-Null
  $plan = Invoke-RestMethod 'http://localhost:3001/api/daily-plan' -WebSession $sess -TimeoutSec 20
  Write-Output "  regime: $($plan.regime)"
  foreach ($r in $plan.rules) { Write-Output "  - $r" }
} catch { Write-Output "  plan err: $($_.Exception.Message)" }
