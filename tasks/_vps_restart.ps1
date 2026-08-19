# Restart the VPS server so the new sizing.js is actually loaded — node caches the
# module, so a file copy alone changes nothing in the running process.
#
# Stop the scheduled task FIRST, then kill only the PID holding 3001. Never a tree
# kill: that takes the MT5 bridge with it as collateral damage.
$ErrorActionPreference = 'Continue'

Write-Output '=== before ==='
$before = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($before) { Write-Output ('  port 3001 held by PID ' + $before.OwningProcess) } else { Write-Output '  nothing on 3001' }

try { Stop-ScheduledTask -TaskName 'SmartEntryServer' -ErrorAction Stop; Write-Output '  stopped task SmartEntryServer' } catch { Write-Output ('  Stop-ScheduledTask: ' + $_.Exception.Message) }
Start-Sleep -Seconds 2

$conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Output ('  stopped node PID ' + $conn.OwningProcess + ' (single PID, no tree kill)')
}
Start-Sleep -Seconds 3

try { Start-ScheduledTask -TaskName 'SmartEntryServer' -ErrorAction Stop; Write-Output '  started task SmartEntryServer' } catch { Write-Output ('  Start-ScheduledTask: ' + $_.Exception.Message) }

# The server needs a moment to bind and load its caches before it answers.
Start-Sleep -Seconds 20

Write-Output ''
Write-Output '=== after ==='
$after = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($after) { Write-Output ('  port 3001 held by PID ' + $after.OwningProcess) } else { Write-Output '  NOTHING on 3001' }

foreach ($ep in @('/api/signals', '/api/healer', '/api/risk-status', '/api/strategy-settings')) {
    try {
        $r = Invoke-WebRequest -Uri ('http://localhost:3001' + $ep) -UseBasicParsing -TimeoutSec 12
        Write-Output ('  ' + $ep + ' -> http ' + $r.StatusCode)
    } catch {
        Write-Output ('  ' + $ep + ' -> FAIL ' + $_.Exception.Message)
    }
}

Write-Output ''
Write-Output '=== live proof: /api/size with a Gold SELL against an open Gold BUY ==='
$body = @{
    accountBalance = 10000
    signal = @{ symbol = 'XAUUSD'; direction = 'SELL'; entry = 4296.78; stop = 4431.30; target = 4083.07; confidence = 73 }
    openPositions = @(@{ symbol = 'XAUUSD'; direction = 'BUY'; entry = 4241.74; stop = 4166.05; lots = 0.01 })
} | ConvertTo-Json -Depth 6
try {
    $resp = Invoke-RestMethod -Uri 'http://localhost:3001/api/size' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15
    Write-Output ('  approved=' + $resp.approved + '  reason=' + $resp.reason)
} catch {
    Write-Output ('  /api/size FAILED: ' + $_.Exception.Message)
}
