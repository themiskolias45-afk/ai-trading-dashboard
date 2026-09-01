Set-Location 'C:\ai-trading-dashboard'
$all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
Write-Output "node.exe processes: $($all.Count)"
foreach ($n in $all) { Write-Output ("  PID {0} :: {1}" -f $n.ProcessId, ($n.CommandLine -replace '\s+',' ')) }
$p = @($all | Where-Object {
  $_.CommandLine -like '*index.js*' -and $_.CommandLine -notlike '*_npx*' -and
  $_.CommandLine -notlike '*npm-cache*' -and $_.CommandLine -notlike '*node_modules*' })
Write-Output "server matches: $($p.Count)"
if ($p.Count -ne 1) { Write-Output 'REFUSE: not exactly one'; exit 1 }
Write-Output "killing PID $($p[0].ProcessId)"
Stop-Process -Id $p[0].ProcessId -Force
Start-Sleep -Seconds 3
schtasks /Run /TN "SmartEntry EnsureRunning" | Out-Null
Start-Sleep -Seconds 45
try {
  $st = Invoke-RestMethod -Uri 'http://localhost:3001/api/status' -TimeoutSec 10
  Write-Output "startedAt $($st.startedAt)"
} catch { Write-Output "STATUS FAILED: $($_.Exception.Message)" }
