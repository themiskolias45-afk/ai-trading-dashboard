Set-Location 'C:\ai-trading-dashboard'
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$bak = "C:\ai-trading-dashboard\tasks\logs\index.js.bak-learncomment-$ts"
Copy-Item 'server\index.js' $bak -Force
if (-not (Test-Path $bak)) { Write-Output 'BACKUP_FAIL - refusing'; exit 1 }
Write-Output "BACKUP_OK $bak"
python tasks\fix_learn_comments_vps.py
if (-not $?) { Write-Output 'PATCH FAILED - file untouched'; exit 1 }
node --check server\index.js
if ($?) { Write-Output 'NODE_CHECK_PASSED' } else { Write-Output 'NODE_CHECK_FAILED'; Copy-Item $bak 'server\index.js' -Force; Write-Output 'ROLLED BACK'; exit 1 }
