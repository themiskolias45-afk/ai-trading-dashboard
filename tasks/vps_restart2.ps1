Set-Location 'C:\ai-trading-dashboard'
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*index.js*' -and $_.CommandLine -notlike '*_npx*' -and
  $_.CommandLine -notlike '*npm-cache*' -and $_.CommandLine -notlike '*node_modules*' })
if ($p.Count -ne 1) { Write-Output "REFUSE: matched $($p.Count)"; exit 1 }
Write-Output "killing PID $($p[0].ProcessId)"
Stop-Process -Id $p[0].ProcessId -Force
Start-Sleep -Seconds 4
schtasks /Run /TN "SmartEntryEnsureRunning" | Out-Null
Start-Sleep -Seconds 50
try { $st = Invoke-RestMethod 'http://localhost:3001/api/status' -TimeoutSec 10; Write-Output "startedAt $($st.startedAt)" }
catch { Write-Output "STATUS FAILED: $($_.Exception.Message)"; exit 1 }
node tasks\plan_probe.cjs
