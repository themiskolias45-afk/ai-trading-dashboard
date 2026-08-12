# Restart the SmartEntry server without taking the MT5 bridges with it.
#
#   powershell -File tasks\safe_server_restart.ps1              # dry run, changes nothing
#   powershell -File tasks\safe_server_restart.ps1 -Execute
#
# ASCII ONLY, DELIBERATELY. Windows PowerShell 5.1 reads a .ps1 as ANSI unless the file
# carries a BOM, so a single em-dash in a double-quoted string arrives as garbage
# containing a quote character and the whole script fails to parse. Keep it to ASCII
# rather than depending on a BOM surviving every copy and scp.
#
# WHY THIS EXISTS
# The documented process filter is not enough. `CommandLine -like '*index.js*'` also
# matches every npx-launched node process (_npx\<hash>\node_modules\.bin\...\index.js),
# sixteen of them on the laptop, so a naive kill takes out unrelated MCP servers, and
# `taskkill /T` takes out the bridges as collateral because they are children. A restart
# that silently no-ops looks exactly like the code change not working.
#
# WHAT IS AND IS NOT AT RISK
# The circuit breaker is NOT lost. The bridge owns it and persists it to
# breaker_state_<TAG>.json (mt5_bridge.py), then re-pushes; the server's copy is
# derived. Two things do happen and both are expected:
#   - positions read zero for roughly a minute, because that cache is bridge-populated
#   - signals come off Yahoo until the first MT5 push lands, up to ~5 minutes, and the
#     bridge's STALE SOURCE guard is what stops a wrong-instrument order in that window
#
# Refuses unless EXACTLY ONE process matches. Never touches python.

param([switch]$Execute)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$mode = if ($Execute) { 'EXECUTE' } else { 'DRY RUN' }
Write-Host "safe_server_restart [$mode]  project=$proj"

function Get-Status {
    try { return Invoke-RestMethod 'http://localhost:3001/api/status' -TimeoutSec 8 }
    catch { return $null }
}

$before = Get-Status
if ($before) { Write-Host "  server answering, startedAt=$($before.startedAt)" }
else { Write-Host "  server NOT answering before restart" }

# Bridges must be alive and staying that way. If a bridge is already silent, a server
# restart muddies the diagnosis of a problem that is not the server's.
try {
    $health = Invoke-RestMethod 'http://localhost:3001/api/mt5/health?account=A' -TimeoutSec 8
    Write-Host "  bridge A connected=$($health.connected) age=$([int]($health.ageMs/1000))s"
} catch { Write-Host "  bridge A health unreadable: $($_.Exception.Message)" }

$pythonBefore = @(Get-CimInstance Win32_Process -Filter "Name LIKE '%python%'")
Write-Host "  python processes before: $($pythonBefore.Count)  (these must survive)"

$all = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
$server = @($all | Where-Object {
    $_.CommandLine -like '*index.js*' -and
    $_.CommandLine -notlike '*_npx*' -and
    $_.CommandLine -notlike '*npm-cache*' -and
    $_.CommandLine -notlike '*node_modules*'
})
Write-Host "  node.exe total: $($all.Count)   server matches: $($server.Count)"
foreach ($s in $server) { Write-Host "    PID $($s.ProcessId)  $($s.CommandLine)" }

if ($server.Count -ne 1) {
    Write-Host "REFUSING: expected exactly 1 server process, found $($server.Count)."
    Write-Host "Zero means it is already down (just start it). More than one means two"
    Write-Host "servers are bound to the same port and that needs a human, not a kill."
    exit 2
}

if (-not $Execute) {
    Write-Host "DRY RUN. Would stop PID $($server[0].ProcessId) and restart. Re-run with -Execute."
    exit 0
}

$targetPid = $server[0].ProcessId
Write-Host "stopping PID $targetPid (no /T, because the children are the bridges)"
Stop-Process -Id $targetPid -Force -Confirm:$false
Start-Sleep -Seconds 3

# Prefer the scheduled task. A Start-Process launched from an interactive SSH session
# is a CHILD of that session, so it dies when the connection closes: on 2026-08-12 the
# server booted cleanly, logged a full startup, served /api/status, and was gone a
# minute later when ssh disconnected. The task scheduler owns a detached session and
# does not have that problem. Falling back to Start-Process is still right for a local
# console, where nothing is about to disconnect.
# The two boxes name this differently: the VPS has a dedicated SmartEntryServer task,
# the laptop does not and relies on 'SmartEntry Ensure Running', which starts the
# server when it is down and never kills anything. Either is preferable to
# Start-Process, which is only reached when neither exists.
$serverTask = Get-ScheduledTask -TaskName 'SmartEntryServer' -ErrorAction SilentlyContinue
$ensureTask = Get-ScheduledTask -TaskName 'SmartEntry Ensure Running' -ErrorAction SilentlyContinue
if ($serverTask) {
    Write-Host "starting server via scheduled task SmartEntryServer (survives an SSH disconnect)"
    try { Stop-ScheduledTask -TaskName 'SmartEntryServer' -ErrorAction Stop } catch { }
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName 'SmartEntryServer'
} elseif ($ensureTask) {
    Write-Host "starting server via scheduled task 'SmartEntry Ensure Running' (detached, also refills bridges)"
    Start-ScheduledTask -TaskName 'SmartEntry Ensure Running'
} else {
    Write-Host "no scheduled task on this box, starting a detached process"
    Write-Host "  NOTE: over SSH this dies with the session. Run it locally."
    Start-Process -FilePath 'cmd' `
        -ArgumentList '/c', 'cd server && node index.js >> ..\tasks\logs\server_log.txt 2>&1' `
        -WorkingDirectory $proj -WindowStyle Minimized
}

# Poll rather than sleep-and-hope: the same lesson as ensure_running.ps1, where a flat
# 8s wait missed a 15s boot by 3 seconds and reported a healthy server as dead.
$waited = 0
$after = $null
while ($waited -lt 60) {
    Start-Sleep -Seconds 3
    $waited += 3
    $after = Get-Status
    if ($after) { break }
}

if (-not $after) {
    Write-Host "FAILED: server did not answer within ${waited}s. See tasks\logs\server_log.txt"
    exit 1
}
if ($before -and $after.startedAt -eq $before.startedAt) {
    Write-Host "FAILED: startedAt unchanged ($($after.startedAt)). The restart silently no-opped."
    exit 1
}
Write-Host "server up after ${waited}s, startedAt=$($after.startedAt)"

$pythonAfter = @(Get-CimInstance Win32_Process -Filter "Name LIKE '%python%'")
Write-Host "python processes after: $($pythonAfter.Count) (was $($pythonBefore.Count))"
if ($pythonAfter.Count -lt $pythonBefore.Count) {
    Write-Host "WARNING: a python process disappeared. Check the bridges immediately."
    exit 1
}
Write-Host "done. Positions read zero for ~60s and signals are Yahoo-derived until the first MT5 push."
