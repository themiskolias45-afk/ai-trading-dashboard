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

# WAIT BY POLLING, NOT BY A FIXED SLEEP.
#
# Measured 2026-09-09: this box took roughly 25-30s to bind after Start-ScheduledTask,
# so the flat 20s sleep that used to be here printed "NOTHING on 3001" and four
# "FAIL Unable to connect" lines on a COMPLETELY SUCCESSFUL restart. The only reason the
# contradiction was visible at all is that the script's own /api/size probe, a few
# seconds further down, answered fine against the server it had just declared dead.
#
# That is the inverse of the hazard CLAUDE.md already names: a restart that silently
# no-opped looks exactly like the code change not working. Here a restart that WORKED
# looked exactly like one that failed, on the box that trades - which is how a live
# server gets chased as a dead one, or worse, restarted a second time underneath itself.
#
# Polling also makes the script honest on a genuinely dead server: it says how long it
# waited instead of implying 20s was ever the answer.
$SETTLE_TIMEOUT_S = 90
$SETTLE_POLL_S    = 3
$waited = 0
$serverUp = $false
while (-not $serverUp -and $waited -lt $SETTLE_TIMEOUT_S) {
    Start-Sleep -Seconds $SETTLE_POLL_S
    $waited += $SETTLE_POLL_S
    try {
        $null = Invoke-RestMethod -Uri 'http://localhost:3001/api/status' -TimeoutSec 6 -ErrorAction Stop
        $serverUp = $true
    } catch {
        $serverUp = $false
    }
}
if ($serverUp) {
    Write-Output ('  server answered after ' + $waited + 's')
} else {
    Write-Output ('  server still not answering after ' + $waited + 's -- see tasks\logs\server_log.txt')
}

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
