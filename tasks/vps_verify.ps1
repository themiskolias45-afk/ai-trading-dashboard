Set-Location 'C:\ai-trading-dashboard'
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$bak = "C:\ai-trading-dashboard\tasks\logs\index.js.bak-plan-$ts"
Copy-Item 'C:\ai-trading-dashboard\server\index.js' $bak -Force
if (Test-Path $bak) { Write-Output "BACKUP_OK $bak" } else { Write-Output 'BACKUP_FAIL' }
node --check server\index.js
if ($?) { Write-Output 'NODE_CHECK_PASSED' } else { Write-Output 'NODE_CHECK_FAILED' }
node -e "const s=require('fs').readFileSync('server/index.js','utf8');const CR=String.fromCharCode(13),LF=String.fromCharCode(10);const crlf=s.split(CR+LF).length-1;const lf=s.split(LF).length-1;console.log('hasBlock',s.includes('WHAT THIS SYSTEM ACTUALLY KNOWS TODAY'),'crlf',crlf,'bareLF',lf-crlf,'bytes',Buffer.byteLength(s))"
Write-Output '--- existing pre-existing backups of index.js ---'
Get-ChildItem 'C:\ai-trading-dashboard\tasks\logs\index.js.bak-*','C:\ai-trading-dashboard\server\index.js.bak-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name,LastWriteTime,Length | Format-Table -AutoSize
