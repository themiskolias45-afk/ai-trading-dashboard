# Finish the consolidation automatically, but ONLY when it is provably safe.
#
#   powershell -ExecutionPolicy Bypass -File tasks\phase2_when_flat.ps1           # check once
#   powershell -ExecutionPolicy Bypass -File tasks\phase2_when_flat.ps1 -Execute  # check and act
#
# ASCII ONLY - PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#
# WHAT IT DOES
#   Disables the three laptop executor tasks (TK / CRT / FVG) once this box's book is
#   flat. That is the last piece of "the VPS is the only trading node".
#
# WHAT IT DELIBERATELY DOES NOT DO, AND WHY - read this before "improving" it
#
#   It does NOT disarm the MT5 bridge. The obvious switch is BRIDGE_MODE=SEMI, which
#   start_bridge_A.bat:94 turns into dropping --auto. Reading mt5_bridge.py before
#   using it: without --auto, prompt_confirm() calls input() at line ~1952. This bridge
#   is started by a scheduled task with NO CONSOLE, so input() either raises EOFError
#   and KILLS THE BRIDGE or blocks forever - and the watchdog then restarts it in a
#   loop. That would strand any open position. Semi mode ALSO skips the minStrength
#   filter (1981) and skips the Claude AI filter (2152), so it is less guarded, not
#   more. BRIDGE_MODE=SEMI is a human-at-a-console switch. It is not a disarm.
#
#   It does NOT touch MT5_EXPECTED_ACCOUNTS. Get-ExpectedBridgeTags falls back to
#   @('A','B') on an empty value, so blanking it would start MORE bridges, including
#   one on the VPS's account - the exact duplicate-bridge fault bridge_tags.ps1 was
#   written to prevent.
#
#   So the laptop bridge keeps trading account A. That is not an omission. It blocks
#   nothing, it strands nothing, and every fill it closes is another sample against
#   the one constraint the evidence board calls binding.
#
# THE SAFETY PROPERTY THAT MATTERS
#   This never stands the laptop down unless the VPS is PROVABLY taking the same
#   signals: VPS server up, VPS bridge connected, VPS signals answering, VPS not
#   halted. So no signal is blocked - it is taken on the other box. Any check that
#   cannot be MADE counts as a failure, never as a pass. Fail-safe is "do nothing".

param(
    [switch]$Execute,
    [int]$RequiredConsecutivePasses = 3
)

$ErrorActionPreference = 'Stop'

$Proj      = Split-Path -Parent $PSScriptRoot
$LogFile   = Join-Path $Proj 'tasks\logs\phase2_when_flat.txt'
$StateFile = Join-Path $Proj 'tasks\phase2_when_flat_state.json'
$BackupDir = Join-Path $Proj 'tasks\logs\phase2-predisarm-backup'
$Consolidate = Join-Path $Proj 'tasks\consolidate_to_vps.ps1'
$TaskName  = 'SmartEntry Phase2 When Flat'

$LocalBase = 'http://localhost:3001'
$VpsHost   = 'vps'   # ~/.ssh/config Host entry

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

function Get-Json($url) {
    try { return @{ ok = $true; data = (Invoke-RestMethod -Uri $url -TimeoutSec 8 -ErrorAction Stop) } }
    catch { return @{ ok = $false; reason = $_.Exception.Message } }
}

function Get-VpsJson($path) {
    # ssh, because these routes are login-gated and the MCP server holds the session.
    try {
        $raw = & ssh -o ConnectTimeout=12 -o BatchMode=yes $VpsHost "curl.exe -s -m 8 `"http://localhost:3001$path`"" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return @{ ok = $false; reason = "ssh/curl returned nothing (exit $LASTEXITCODE)" } }
        return @{ ok = $true; data = ($raw | ConvertFrom-Json) }
    } catch { return @{ ok = $false; reason = $_.Exception.Message } }
}

Write-Log "phase2_when_flat  execute=$Execute  passesNeeded=$RequiredConsecutivePasses"

# ---------------------------------------------------------------------------
# Already done? Then retire quietly. Idempotent by design - this runs on a timer.
# ---------------------------------------------------------------------------
$execTasks = @('SmartEntry Executor TK', 'SmartEntry Executor CRT', 'SmartEntry Executor FVG')
$stillOn = @(Get-ScheduledTask | Where-Object { $_.TaskName -in $execTasks -and $_.State -ne 'Disabled' })
if ($stillOn.Count -eq 0) {
    Write-Log "  executors already disabled - nothing to do."
    if ($Execute) {
        try { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null; Write-Log "  retired self ($TaskName)." } catch { }
    }
    exit 0
}

# ---------------------------------------------------------------------------
# GATE 1-3: this box. Flat, and truthfully so.
# ---------------------------------------------------------------------------
$fail = @()

$status = Get-Json "$LocalBase/api/status"
if (-not $status.ok) { $fail += "local server did not answer ($($status.reason))" }

$health = Get-Json "$LocalBase/api/mt5/health?account=A"
if (-not $health.ok) {
    $fail += "local bridge health unreadable ($($health.reason))"
} elseif (-not $health.data.connected) {
    # A disconnected bridge cannot be trusted to report the book. "No positions
    # returned" from a dead bridge is not flatness, it is blindness.
    $fail += "local bridge NOT connected - its position list is not evidence"
}

$openCount = $null
$pos = Get-Json "$LocalBase/api/mt5/positions"
if (-not $pos.ok) {
    $fail += "local positions unreadable ($($pos.reason))"
} else {
    $ours = @($pos.data.positions)
    $openCount = $ours.Count
    if ($openCount -gt 0) {
        $fail += "$openCount position(s) still open here"
        foreach ($p in $ours) { Write-Log "    OPEN  $($p.symbol) $($p.type) $($p.volume) profit=$($p.profit)" }
    }
}

# ---------------------------------------------------------------------------
# GATE 4-6: the VPS. This is the "do not block trading" guarantee - the laptop only
# stands down if the other node is demonstrably taking the same signals.
# ---------------------------------------------------------------------------
$vStatus = Get-VpsJson '/api/status'
if (-not $vStatus.ok) { $fail += "VPS server unreachable ($($vStatus.reason))" }

$vHealth = Get-VpsJson '/api/mt5/health?account=A'
if (-not $vHealth.ok) {
    $fail += "VPS bridge health unreadable ($($vHealth.reason))"
} elseif ($null -eq $vHealth.data.PSObject.Properties['connected']) {
    $fail += "VPS bridge health carried no 'connected' field - got: $(($vHealth.data | ConvertTo-Json -Compress -Depth 2))"
} elseif ($vHealth.data.connected -ne $true) {
    $fail += "VPS bridge NOT connected - it cannot place the trades this box would stop taking"
}

$vSig = Get-VpsJson '/api/signals'
if (-not $vSig.ok) {
    $fail += "VPS signals unreadable ($($vSig.reason))"
} else {
    $s = $vSig.data.signals
    if (-not $s) { $s = $vSig.data }
    $scored = @('btc','gold','spx') | Where-Object { $s.$_ -and $null -ne $s.$_.confidence }
    if ($scored.Count -lt 3) { $fail += "VPS scored only $($scored.Count) of 3 assets - its engine is not fully live" }
}

$vRisk = Get-VpsJson '/api/risk-status'
if (-not $vRisk.ok) {
    $fail += "VPS risk-status unreadable ($($vRisk.reason))"
} elseif ($null -eq $vRisk.data.PSObject.Properties['halted']) {
    # An error body is still VALID JSON. {"error":"Not logged in."} has no 'halted'
    # property, so a bare truthiness test would read it as "not halted" and PASS.
    # That is the same shape as the CLI rail returning a sign-in error as analysis:
    # the ABSENCE of the field must fail, never pass.
    $fail += "VPS risk-status carried no 'halted' field - got: $(($vRisk.data | ConvertTo-Json -Compress -Depth 2))"
} elseif ($vRisk.data.halted) {
    $fail += "VPS is HALTED ($($vRisk.data.haltReason)) - standing this box down too would leave nothing trading"
}

# ---------------------------------------------------------------------------
# Verdict, and the consecutive-pass counter. One clean read is not evidence: a
# position can be momentarily absent between a close and the journal catching up.
# ---------------------------------------------------------------------------
$state = @{ passes = 0; lastPassAt = $null }
if (Test-Path $StateFile) {
    try { $j = Get-Content $StateFile -Raw | ConvertFrom-Json; $state.passes = [int]$j.passes; $state.lastPassAt = $j.lastPassAt } catch { }
}

if ($fail.Count -gt 0) {
    Write-Log "  NOT SAFE YET - $($fail.Count) gate(s) failed:"
    foreach ($f in $fail) { Write-Log "    - $f" }
    if ($state.passes -ne 0) { Write-Log "  streak reset ($($state.passes) -> 0)" }
    $state.passes = 0
    if ($Execute) { $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding utf8 }
    exit 0
}

$state.passes = $state.passes + 1
$state.lastPassAt = (Get-Date).ToString('o')
Write-Log "  ALL GATES PASS (book flat here, VPS live and taking signals). streak=$($state.passes)/$RequiredConsecutivePasses"
if ($Execute) { $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding utf8 }

if ($state.passes -lt $RequiredConsecutivePasses) {
    Write-Log "  holding for $($RequiredConsecutivePasses - $state.passes) more consecutive pass(es)."
    exit 0
}

if (-not $Execute) { Write-Log "  would ACT now, but -Execute was not given."; exit 0 }

# ---------------------------------------------------------------------------
# BACK UP EVERYTHING FIRST. Standing rule 4, and his own words: do not lose any
# data, learning, brain or memory. Copied and VERIFIED before a single task is
# touched. Any failure here aborts and changes nothing.
# ---------------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest  = Join-Path $BackupDir $stamp
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Directories are copied whole; files individually. Nothing is moved, nothing removed.
$wanted = @(
    'server\learning.json', 'server\journal.json', 'server\learning_shadow.json',
    'server\hermes_state.json',
    'tasks\all_trades_ledger.jsonl', 'tasks\trade_ledger_summary.json',
    'tasks\decision_register.jsonl', 'tasks\strategy_search_ledger.jsonl',
    'tasks\jarvis_memory.json'
)
$wantedDirs = @('tasks\daily', 'tasks\eod_reports', 'tasks\analysis')

$copied = 0; $missing = @(); $failedCopy = @()
foreach ($rel in $wanted) {
    $src = Join-Path $Proj $rel
    if (-not (Test-Path $src)) { $missing += $rel; continue }
    $out = Join-Path $dest ($rel -replace '[\\/]', '_')
    try {
        Copy-Item -Path $src -Destination $out -Force -ErrorAction Stop
        if (Test-Path $out) { $copied++ } else { $failedCopy += $rel }
    } catch { $failedCopy += "$rel ($($_.Exception.Message))" }
}
foreach ($rel in $wantedDirs) {
    $src = Join-Path $Proj $rel
    if (-not (Test-Path $src)) { $missing += $rel; continue }
    $out = Join-Path $dest ($rel -replace '[\\/]', '_')
    try {
        Copy-Item -Path $src -Destination $out -Recurse -Force -ErrorAction Stop
        if (Test-Path $out) { $copied++ } else { $failedCopy += $rel }
    } catch { $failedCopy += "$rel ($($_.Exception.Message))" }
}

Write-Log "  backup -> $dest  (copied $copied, absent $($missing.Count), FAILED $($failedCopy.Count))"
foreach ($m in $missing)    { Write-Log "    absent (not an error, nothing to lose): $m" }
foreach ($f in $failedCopy) { Write-Log "    COPY FAILED: $f" }

if ($failedCopy.Count -gt 0) {
    Write-Log "  ABORTING: a backup copy failed. Nothing was disabled. Standing rule 4."
    exit 4
}
if ($copied -eq 0) {
    Write-Log "  ABORTING: backed up nothing at all. That is not a clean box, that is a broken path."
    exit 4
}

# The brain/vault is backed up by SmartEntryVaultBackup, which stays enabled. Recorded
# here so a reader knows it was considered rather than forgotten.
Write-Log "  vault/brain: covered by SmartEntryVaultBackup (still enabled) - not duplicated here."

# ---------------------------------------------------------------------------
# ACT. consolidate_to_vps.ps1 -Phase2 re-checks flatness itself and REFUSES if the
# book reopened between our check and this call. Two independent gates on purpose.
# ---------------------------------------------------------------------------
Write-Log "  handing off to consolidate_to_vps.ps1 -Phase2 -Execute"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Consolidate -Phase2 -Execute
$rc = $LASTEXITCODE
Write-Log "  consolidate -Phase2 exit=$rc"

if ($rc -ne 0) {
    Write-Log "  it refused or failed. Nothing further done. Streak kept so it retries."
    exit $rc
}

# Proof is the task state, not the exit code.
$after = @(Get-ScheduledTask | Where-Object { $_.TaskName -in $execTasks -and $_.State -ne 'Disabled' })
Write-Log "  executors still enabled after: $($after.Count) (expected 0)"
if ($after.Count -ne 0) { Write-Log "  WARNING: not all executors disabled. Leaving self enabled to retry."; exit 1 }

Write-Log "  CONSOLIDATION COMPLETE. The VPS is the only trading node."
Write-Log "  laptop bridge: STILL TRADING account A, deliberately - see the header."
Write-Log "  reverse with: powershell -File tasks\consolidate_to_vps.ps1 -Restore <dir> -Execute"

try { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null; Write-Log "  retired self ($TaskName)." }
catch { Write-Log "  could not retire self: $($_.Exception.Message) - harmless, it no-ops from now on." }

exit 0
