Set-Location 'C:\ai-trading-dashboard'
$ts  = Get-Date -Format 'yyyyMMdd_HHmmss'
$bak = "C:\ai-trading-dashboard\tasks\logs\index.js.bak-heldfix-$ts"
Copy-Item 'server\index.js' $bak -Force
if (-not (Test-Path $bak)) { Write-Output 'BACKUP_FAIL - refusing'; exit 1 }
Write-Output "BACKUP_OK $bak"
foreach ($script in @('vps_fix_held.py','vps_fix_planrefresh.py','vps_fix_held2.py')) {
  Write-Output "--- $script ---"
  python "tasks\$script" 'C:\ai-trading-dashboard\server\index.js'
  if (-not $?) { Write-Output "PATCH FAILED at $script - rolling back"; Copy-Item $bak 'server\index.js' -Force; exit 1 }
}
node --check server\index.js
if ($?) { Write-Output 'NODE_CHECK_PASSED' } else { Write-Output 'NODE_CHECK_FAILED - rolling back'; Copy-Item $bak 'server\index.js' -Force; exit 1 }
