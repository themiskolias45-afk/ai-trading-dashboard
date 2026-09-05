# Restart the LAPTOP server. Mirror of tasks\_vps_restart.ps1, for the box that has no
# SmartEntryServer scheduled task.
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY A SCRIPT AND NOT AN AD-HOC KILL
# node caches modules, so editing server/index.js changes nothing in the running process
# and a restart is the only way to load it. But the obvious command is wrong twice over:
#
#   1. CLAUDE.md: `CommandLine -like "*index.js*"` also matches every npx-launched node
#      process (sixteen on this laptop). Killing by that filter can take an unrelated
#      process, and a restart that silently no-opped looks exactly like the code change
#      not working.
#   2. Never a tree kill. tasks\_vps_restart.ps1 says why in one line: "that takes the
#      MT5 bridge with it as collateral damage." The bridge is a separate python process
#      and must survive.
#
# So: identify the SINGLE pid holding port 3001, stop only that, then let
# tasks\ensure_running.ps1 bring it back. ensure_running fills gaps and never kills, so
# it is safe to run at any time.
#
# WHAT A SERVER RESTART DOES NOT DO: it does not close a position and it does not touch
# the bridge. Open trades carry broker-side stops that live on the broker, not here.
# This script prints the position count before and after anyway, because "positions: 0"
# during the bridge's startup grace window reads exactly like a flat book and has been
# misread that way before.
#
#   powershell -File tasks\_laptop_restart.ps1 [-WhatIf]

param([switch]$WhatIf)

$ErrorActionPreference = 'Continue'
$base = 'http://localhost:3001'

function Show-State([string]$label) {
    Write-Output "=== $label ==="
    $conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { Write-Output ('  port 3001 held by PID ' + $conn.OwningProcess) } else { Write-Output '  nothing on 3001' }
    try {
        $s = Invoke-RestMethod -Uri ($base + '/api/status') -TimeoutSec 8
        Write-Output ('  startedAt ' + $s.startedAt)
    } catch { Write-Output '  /api/status did not answer' }
    try {
        $p = Invoke-RestMethod -Uri ($base + '/api/mt5/positions') -TimeoutSec 8
        $n = @($p.positions).Count + @($p.unmanaged).Count
        Write-Output ('  positions ' + $n)
    } catch { Write-Output '  /api/mt5/positions did not answer (session-gated or down)' }
    return $conn
}

$before = Show-State 'before'

if ($WhatIf) {
    Write-Output ''
    Write-Output '-WhatIf: would stop the single PID above, then run tasks\ensure_running.ps1.'
    exit 0
}

if (-not $before) {
    Write-Output ''
    Write-Output '  nothing listening on 3001 - skipping the stop, going straight to ensure_running'
} else {
    Stop-Process -Id $before.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Output ('  stopped PID ' + $before.OwningProcess + ' (single PID by port, no tree kill)')
    Start-Sleep -Seconds 3
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ensure_running.ps1') | Select-Object -Last 8

# The server needs a moment to bind and load its caches before it answers.
Start-Sleep -Seconds 20
Write-Output ''
$after = Show-State 'after'

foreach ($ep in @('/api/signals', '/api/healer', '/api/strategy-settings')) {
    try {
        $r = Invoke-WebRequest -Uri ($base + $ep) -UseBasicParsing -TimeoutSec 12
        Write-Output ('  ' + $ep + ' -> http ' + $r.StatusCode)
    } catch {
        Write-Output ('  ' + $ep + ' -> FAIL ' + $_.Exception.Message)
    }
}

if (-not $after) {
    Write-Output ''
    Write-Output '  WARNING: nothing is listening on 3001. Start it with option S in tasks\menu.bat.'
}
