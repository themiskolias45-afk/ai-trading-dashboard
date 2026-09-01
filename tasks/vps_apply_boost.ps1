Set-Location 'C:\ai-trading-dashboard'
$ts  = Get-Date -Format 'yyyyMMdd_HHmmss'
$bak = "C:\ai-trading-dashboard\tasks\logs\index.js.bak-boost-$ts"
Copy-Item 'server\index.js' $bak -Force
if (-not (Test-Path $bak)) { Write-Output 'BACKUP_FAIL - refusing to patch'; exit 1 }
Write-Output "BACKUP_OK $bak"

python 'tasks\vps_fix_boost.py' 'C:\ai-trading-dashboard\server\index.js'
if (-not $?) { Write-Output 'PATCH FAILED - file untouched'; exit 1 }

node --check server\index.js
if ($?) {
  Write-Output 'NODE_CHECK_PASSED'
} else {
  Write-Output 'NODE_CHECK_FAILED - rolling back'
  Copy-Item $bak 'server\index.js' -Force
  exit 1
}

Write-Output '--- boost against the REAL learning.json on THIS box ---'
node -e "const fs=require('fs');const src=fs.readFileSync('server/index.js','utf8');const a=src.indexOf('function getLearningBoost(setup) {');const b=src.indexOf(String.fromCharCode(10)+'}',a)+2;const learning=JSON.parse(fs.readFileSync('server/learning.json','utf8'));const fn=new Function('learning','LEARNING_MIN_TRADES','LEARNING_BOOST_CAP','LEARNING_BOOST_SPAN','LEARNING_SHRINK_PSEUDO_TRADES',src.slice(a,b)+'; return getLearningBoost;');const g=fn(learning,5,15,30,10);for(const k of Object.keys(learning.setupStats)){const v=learning.setupStats[k];console.log('  '+k+'  W'+v.wins+'/L'+v.losses+'  boost '+g(k));}"
