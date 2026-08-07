# Prove nothing in the SmartEntry stack is running blind.
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File tasks\coverage_audit.ps1
#
# WHY
# Every outage this project has had looked identical to health while it was
# happening. The VPS placed no orders for eleven days with every check green. Both
# daily agents answered "I don't have the data" for weeks. The trailing stop had
# never fired once. SmartEntryAutoStart has never run at all and still reports
# "Ready". A component that is ABSENT reads the same as one that is fine, and that
# is the failure shape here -- not crashes, silence.
#
# This asks one question of every moving part: when did it last actually do its job,
# and does anything notice if it stops? A check that cannot be answered is reported
# UNKNOWN, never assumed healthy.
#
# Portable: paths come from $PSScriptRoot, so it runs unchanged on the laptop
# (C:\Users\User\ai-trading-dashboard) and the VPS (C:\ai-trading-dashboard).
#
# Exit 0 = all green or amber. Exit 1 = at least one RED. Designed to be run daily
# and to be worth reading when it is quiet.

$ErrorActionPreference = 'Continue'

$Proj    = Split-Path -Parent $PSScriptRoot
$LogDir  = Join-Path $Proj 'tasks\logs'
$SERVER  = 'http://localhost:3001'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

$results = @()
function Add-Check([string]$area, [string]$name, [string]$state, [string]$detail) {
    $script:results += [pscustomobject]@{ Area = $area; Name = $name; State = $state; Detail = $detail }
}

function Get-Json([string]$path, [int]$timeout = 6) {
    try { return Invoke-RestMethod -Uri "$SERVER$path" -TimeoutSec $timeout } catch { return $null }
}

# ── 1. Scheduled tasks: the supervisors themselves ────────────────────────────
# 267009 is "currently running" and 267011 is "has not run yet" -- the second is the
# one that matters. A task registered years ago that has never fired is the purest
# form of blind: it exists, it reports Ready, and it has never done anything.
$now = Get-Date
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'SmartEntry' })
if ($tasks.Count -eq 0) {
    Add-Check 'tasks' 'scheduled tasks' 'RED' 'no SmartEntry tasks registered on this box at all'
} else {
    foreach ($t in $tasks) {
        $i = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
        if ($null -eq $i) { Add-Check 'tasks' $t.TaskName 'UNKNOWN' 'task info unreadable'; continue }

        if ($t.State -eq 'Disabled') { Add-Check 'tasks' $t.TaskName 'INFO' 'disabled deliberately'; continue }

        $ranEver = $i.LastRunTime -and $i.LastRunTime.Year -gt 1999
        $ageH    = if ($ranEver) { [math]::Round(($now - $i.LastRunTime).TotalHours, 1) } else { $null }

        if (-not $ranEver -or $i.LastTaskResult -eq 267011) {
            Add-Check 'tasks' $t.TaskName 'RED' 'registered but has NEVER run'
        } elseif ($i.LastTaskResult -ne 0 -and $i.LastTaskResult -ne 267009) {
            Add-Check 'tasks' $t.TaskName 'RED' "last exit $($i.LastTaskResult), ${ageH}h ago"
        } elseif ($t.State -eq 'Running') {
            Add-Check 'tasks' $t.TaskName 'GREEN' "running (started ${ageH}h ago)"
        } elseif ($null -eq $i.NextRunTime) {
            # No next run and not running: only a trigger nothing will fire can do this.
            Add-Check 'tasks' $t.TaskName 'AMBER' "ok ${ageH}h ago but NO next run scheduled - trigger may never fire again"
        } else {
            Add-Check 'tasks' $t.TaskName 'GREEN' "ok ${ageH}h ago, next $($i.NextRunTime.ToString('MM-dd HH:mm'))"
        }
    }
}

# ── 2. Server ─────────────────────────────────────────────────────────────────
# By HTTP, never by process name: a node process that is alive but wedged is not a
# running server.
$settings = Get-Json '/api/strategy-settings'
if ($null -eq $settings) {
    Add-Check 'server' 'http' 'RED' 'not answering on 3001'
} else {
    Add-Check 'server' 'http' 'GREEN' "gate $($settings.confidenceThreshold), fixedLot $($settings.fixedLotSize)"
    if ($settings.settingsError) {
        # Defaults are NOT the operator's settings: fixedLotSize defaults to 0, which
        # means size from risk on a box configured for micro lots.
        Add-Check 'server' 'strategy settings' 'RED' "UNREADABLE ($($settings.settingsError)) - running on DEFAULTS, not the saved config"
    } else {
        Add-Check 'server' 'strategy settings' 'GREEN' 'loaded from disk'
    }
}

$healer = Get-Json '/api/healer'
if ($null -eq $healer) { Add-Check 'server' 'healer' 'UNKNOWN' 'endpoint unreachable' }
elseif ($healer.healthy) { Add-Check 'server' 'healer' 'GREEN' "healthy, $($healer.healCount) heals" }
else { Add-Check 'server' 'healer' 'RED' 'reporting unhealthy' }

# ── 3. Bridges — per expected tag, by heartbeat ───────────────────────────────
# Liveness is the heartbeat, not a process: Windows reports an EMPTY command line for
# the bridge pythons, so they look absent while trading normally.
$tags = @('A')
$envFile = Join-Path $Proj 'keys.env'
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*MT5_EXPECTED_ACCOUNTS\s*=' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($line) {
        $val = ($line.Line -split '=', 2)[1]
        if ($val) { $parsed = @($val.Trim() -split '\s*,\s*' | Where-Object { $_ }); if ($parsed.Count) { $tags = $parsed } }
    }
}
foreach ($tag in $tags) {
    $h = Get-Json "/api/mt5/health?account=$tag"
    if ($null -eq $h) { Add-Check 'bridge' "tag $tag" 'UNKNOWN' 'server not answering' ; continue }
    if (-not $h.connected) { Add-Check 'bridge' "tag $tag" 'RED' 'not connected'; continue }
    $ageS = [math]::Round($h.ageMs / 1000, 0)
    if ($ageS -gt 180) { Add-Check 'bridge' "tag $tag" 'RED' "last heartbeat ${ageS}s ago (3 missed reports)" }
    elseif ($ageS -gt 90) { Add-Check 'bridge' "tag $tag" 'AMBER' "last heartbeat ${ageS}s ago" }
    else { Add-Check 'bridge' "tag $tag" 'GREEN' "heartbeat ${ageS}s ago" }
}

# ── 4. The AI Employee: is any brief stranded? ────────────────────────────────
$queue = Join-Path $Proj 'tasks\agent_queue.jsonl'
if (-not (Test-Path $queue)) {
    Add-Check 'agents' 'parked briefs' 'GREEN' 'queue empty (no file)'
} else {
    $lines = @(Get-Content $queue -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
    if ($lines.Count -eq 0) { Add-Check 'agents' 'parked briefs' 'GREEN' 'queue empty' }
    else {
        $oldest = $null
        foreach ($l in $lines) {
            try { $j = $l | ConvertFrom-Json } catch { continue }
            if ($j.queuedAt) {
                $qd = [datetime]$j.queuedAt
                if ($null -eq $oldest -or $qd -lt $oldest) { $oldest = $qd }
            }
        }
        $ageH = if ($oldest) { [math]::Round(($now - $oldest).TotalHours, 1) } else { -1 }
        if ($ageH -gt 48) { Add-Check 'agents' 'parked briefs' 'RED' "$($lines.Count) parked, oldest ${ageH}h - past the staleness drop, drain is not running" }
        elseif ($lines.Count -gt 0) { Add-Check 'agents' 'parked briefs' 'AMBER' "$($lines.Count) parked, oldest ${ageH}h - waiting on the limit window" }
    }
}

# ── 5. Self-learning: is evidence still accumulating? ─────────────────────────
foreach ($f in @(
    @{ Name = 'rejection ledger'; Path = 'tasks\rejections.jsonl';        MaxAgeH = 48 },
    @{ Name = 'scored ledger';    Path = 'tasks\rejections_scored.jsonl'; MaxAgeH = 48 },
    @{ Name = 'shadow learning';  Path = 'server\learning_shadow.json';   MaxAgeH = 48 }
)) {
    $p = Join-Path $Proj $f.Path
    if (-not (Test-Path $p)) {
        Add-Check 'learning' $f.Name 'AMBER' "$($f.Path) does not exist yet"
    } else {
        $ageH = [math]::Round(($now - (Get-Item $p).LastWriteTime).TotalHours, 1)
        if ($ageH -gt $f.MaxAgeH) { Add-Check 'learning' $f.Name 'RED' "not updated for ${ageH}h - the daily pipeline is not running" }
        else { Add-Check 'learning' $f.Name 'GREEN' "updated ${ageH}h ago" }
    }
}

# ── report ────────────────────────────────────────────────────────────────────
$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$out = @()
$out += "=========================================================================="
$out += " SmartEntry COVERAGE AUDIT - $stamp"
$out += " box: $env:COMPUTERNAME   project: $Proj"
$out += "=========================================================================="
foreach ($area in @('tasks','server','bridge','agents','learning')) {
    $rows = @($results | Where-Object { $_.Area -eq $area })
    if ($rows.Count -eq 0) { continue }
    $out += ''
    $out += "  [$($area.ToUpper())]"
    foreach ($r in $rows) { $out += ("    {0,-7} {1,-32} {2}" -f $r.State, $r.Name, $r.Detail) }
}
$red     = @($results | Where-Object { $_.State -eq 'RED' })
$amber   = @($results | Where-Object { $_.State -eq 'AMBER' })
$unknown = @($results | Where-Object { $_.State -eq 'UNKNOWN' })
$out += ''
$out += "--------------------------------------------------------------------------"
$out += (" {0} checks: {1} RED, {2} AMBER, {3} UNKNOWN, {4} GREEN/INFO" -f `
    $results.Count, $red.Count, $amber.Count, $unknown.Count,
    (@($results | Where-Object { $_.State -eq 'GREEN' -or $_.State -eq 'INFO' })).Count)
if ($red.Count)     { $out += ' RED   : ' + (($red     | ForEach-Object { $_.Name }) -join ', ') }
if ($unknown.Count) { $out += ' UNKNOWN (could not be answered - NOT the same as healthy): ' + (($unknown | ForEach-Object { $_.Name }) -join ', ') }
$out += "=========================================================================="

$out | ForEach-Object { Write-Output $_ }
$logPath = Join-Path $LogDir 'coverage_audit.txt'
try { $out | Out-File -FilePath $logPath -Encoding utf8 -Append } catch { }

if ($red.Count -gt 0) { exit 1 }
exit 0
