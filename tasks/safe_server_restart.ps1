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
# The two boxes name this differently, and BOTH halves of that were wrong here until
# 2026-08-23. On the VPS this script would have stopped the server on the box that
# trades continuously and then been unable to start it again:
#   - SmartEntryServer EXISTS there, so the first branch was taken, but the task is
#     Interactive/AtLogOn and returns 0x800710E0 on a headless box every single time.
#     Its existence is not evidence that it can start anything.
#   - the fallback looked for 'SmartEntry Ensure Running', the LAPTOP's name. The VPS
#     calls the same task 'SmartEntryEnsureRunning', one word, so it matched nothing.
# Both names are now tried, and SmartEntryServer has to prove it is usable first.
$TASK_REFUSED = 2147946720   # 0x800710E0, "the operator or administrator has refused the request"
$ENSURE_TASK_NAMES = @('SmartEntry Ensure Running', 'SmartEntryEnsureRunning')

$serverTask = Get-ScheduledTask -TaskName 'SmartEntryServer' -ErrorAction SilentlyContinue
$serverTaskUsable = $false
if ($serverTask) {
    $serverTaskInfo = $null
    try { $serverTaskInfo = $serverTask | Get-ScheduledTaskInfo } catch { }
    if ($serverTaskInfo -and $serverTaskInfo.LastTaskResult -eq $TASK_REFUSED) {
        Write-Host "  SmartEntryServer exists but its last result is 0x800710E0: it cannot"
        Write-Host "  start on a headless box. Not using it."
    } else {
        $serverTaskUsable = $true
    }
}

$ensureTask = $null
foreach ($ensureName in $ENSURE_TASK_NAMES) {
    $found = Get-ScheduledTask -TaskName $ensureName -ErrorAction SilentlyContinue
    if ($found) { $ensureTask = $found; break }
}

# THE ENSURE TASK IS PREFERRED, and that ordering is the actual fix.
# The process above is already stopped, so all that is wanted now is something that
# STARTS it. The ensure task does exactly that on both boxes, runs detached, and never
# kills anything, which makes it the safest possible thing to hand the job to. The
# SmartEntryServer Stop-then-Start dance is strictly riskier and is now only a fallback.
#
# Do not go back to disqualifying SmartEntryServer on its LastTaskResult alone. That was
# the first attempt at this fix and it does not hold: on the VPS the task sits in state
# Running, so LastTaskResult reads 4294967295 (0xFFFFFFFF, "currently running") rather
# than the 0x800710E0 it reports once a run has actually completed. The guard passed and
# the branch that cannot start a headless server was chosen anyway. The result code is
# not a reliable signal; the ordering is.
if ($ensureTask) {
    Write-Host "starting server via scheduled task '$($ensureTask.TaskName)' (detached, never kills, also refills bridges)"
    Start-ScheduledTask -TaskName $ensureTask.TaskName
} elseif ($serverTaskUsable) {
    Write-Host "no ensure task; falling back to scheduled task SmartEntryServer"
    try { Stop-ScheduledTask -TaskName 'SmartEntryServer' -ErrorAction Stop } catch { }
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName 'SmartEntryServer'
} else {
    Write-Host "no scheduled task on this box, starting a detached process"
    Write-Host "  NOTE: over SSH this dies with the session. Run it locally."
    Start-Process -FilePath 'cmd' `
        -ArgumentList '/c', 'cd server && node index.js >> ..\tasks\logs\server_log.txt 2>&1' `
        -WorkingDirectory $proj -WindowStyle Minimized
}

# Poll rather than sleep-and-hope: the same lesson as ensure_running.ps1, where a flat
# 8s wait missed a 15s boot by 3 seconds and reported a healthy server as dead.
# Wait for startedAt to CHANGE, not merely for something to answer. Breaking at the
# first 200 gave up too early twice over: the old process can still answer for a moment
# after Stop-Process, and the ensure-task route hands off to a SYSTEM session that can
# take longer than one poll to bind. Either produced a "startedAt unchanged" failure
# report for a restart that was simply still in progress. 90s, because the VPS came
# back in 6s and a cold boot on this laptop has been measured at 15s.
$waited = 0
$after = $null
while ($waited -lt 90) {
    Start-Sleep -Seconds 3
    $waited += 3
    $candidate = Get-Status
    if ($candidate -and (-not $before -or $candidate.startedAt -ne $before.startedAt)) {
        $after = $candidate
        break
    }
}

if (-not $after) {
    Write-Host "FAILED: no NEW server answered within ${waited}s. See tasks\logs\server_log.txt"
    if ($before) { Write-Host "        (startedAt never moved from $($before.startedAt))" }
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
