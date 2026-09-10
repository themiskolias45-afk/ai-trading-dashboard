# Make the VPS the only trading node. The laptop becomes a client.
#
#   powershell -ExecutionPolicy Bypass -File tasks\consolidate_to_vps.ps1            # dry run
#   powershell -ExecutionPolicy Bypass -File tasks\consolidate_to_vps.ps1 -Execute
#   powershell -ExecutionPolicy Bypass -File tasks\consolidate_to_vps.ps1 -Phase2 -Execute
#   powershell -ExecutionPolicy Bypass -File tasks\consolidate_to_vps.ps1 -Restore <backupDir>
#
# ASCII ONLY - PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#
# WHY, measured 2026-09-10
#
#   Of 65 SmartEntry/JARVIS tasks on this laptop:
#     51  also run on the VPS                       - pure duplication
#      7  exist only to manage the OTHER box        - Brain Sync, Fleet Warden, Page
#                                                     Parity, Pull VPS EA Status, Push
#                                                     Laptop State, VpsMonitor,
#                                                     VPSBackupPull
#      6  exist only because this is a laptop       - Crash Forensics, Stay Awake,
#                                                     Morning Ready, SmartEntryPro,
#                                                     Mirror To USB, Data Backup
#      0  do trading work the VPS cannot do
#
#     VPS    46 days uptime, 0 unexpected shutdowns in 14d, headless by design
#     Laptop 7 unexpected shutdowns in 72h, running on battery, and 65/65 of its tasks
#            are LogonType=Interactive so NONE of them run without a login
#
#   Signals were byte-identical across both boxes when this was written (BTC WAIT 40
#   MOMENTUM, GOLD WAIT 40 BUY_DIP, SPX WAIT 0 BB_SQUEEZE_WATCH, gate 70 both), and the
#   VPS Atomic feed is live and fresh, so the laptop adds no read the VPS lacks.
#
#   What ceases to exist with one node: the boot-trigger outage class, parity/engine
#   drift, the TradingView fight between boxes, brain-sync conflicts, the fleet
#   heartbeat that never had a writer, and "committed on the VPS but not live".
#
# WHAT THIS DOES NOT DO
#   - It does not DELETE anything. Standing rule 6. Tasks are DISABLED, and every task
#     definition on the box is exported to XML BEFORE the first change.
#   - It does not touch MT5, the terminals, or the user's own EAs (V10_EA_MASTER,
#     TK_SMART_ENTRY, DeepTrade, ATOMIC_ANALYST). Those are his and stay running.
#   - It does not touch anything while a position is open. The executors that manage
#     the laptop's open book are held back to -Phase2, which REFUSES to run until the
#     laptop's book is flat.
#   - It does not touch the VPS at all.

param(
    [switch]$Execute,
    [switch]$Phase2,
    [string]$Restore
)

$ErrorActionPreference = 'Stop'

$Proj      = Split-Path -Parent $PSScriptRoot
$BackupRoot = Join-Path $Proj 'tasks\logs\schtask-backup-consolidate'
$LogFile   = Join-Path $Proj 'tasks\logs\consolidate_to_vps.txt'
$PosUrl    = 'http://localhost:3001/api/mt5/positions'

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

# ---------------------------------------------------------------------------
# BOX GUARD - this script must NEVER run on the VPS.
#
# It is git-tracked, so it lands on both boxes. On the VPS it would disable ~50 tasks
# on the ONLY trading node. Two independent signatures, both measured 2026-09-10:
#   - the VPS keeps the project at C:\ai-trading-dashboard; the laptop under C:\Users\User
#   - the VPS has scheduled tasks SmartEntryServer and SmartEntryBridgeA; the laptop
#     has NEITHER (its server and bridge come from ensure_running.ps1)
# EITHER signature firing is enough to refuse. A guard that needs both to agree is a
# guard that fails open the moment one of them changes.
# ---------------------------------------------------------------------------
$isVpsLayout = ($Proj -ieq 'C:\ai-trading-dashboard')
$hasVpsTasks = ($null -ne (Get-ScheduledTask -TaskName 'SmartEntryServer'  -ErrorAction SilentlyContinue)) -or `
               ($null -ne (Get-ScheduledTask -TaskName 'SmartEntryBridgeA' -ErrorAction SilentlyContinue))
if ($isVpsLayout -or $hasVpsTasks) {
    Write-Host "REFUSING on $env:COMPUTERNAME - this looks like the VPS (vpsLayout=$isVpsLayout vpsTasks=$hasVpsTasks)."
    Write-Host "This script stands a box DOWN. The VPS is the only trading node. Nothing was changed."
    exit 9
}

# ---------------------------------------------------------------------------
# RESTORE - the way back. Named first so it is impossible to miss.
# ---------------------------------------------------------------------------
if ($Restore) {
    if (-not (Test-Path $Restore)) { Write-Log "REFUSING: no such backup dir: $Restore"; exit 2 }
    $xmls = @(Get-ChildItem -Path $Restore -Filter '*.xml')
    Write-Log "RESTORE from $Restore ($($xmls.Count) task definitions)"
    foreach ($x in $xmls) {
        $name = [IO.Path]::GetFileNameWithoutExtension($x.Name)
        if (-not $Execute) { Write-Log "  would restore: $name"; continue }
        try {
            Register-ScheduledTask -Xml (Get-Content $x.FullName -Raw) -TaskName $name -Force | Out-Null
            Write-Log "  restored: $name"
        } catch { Write-Log "  FAILED to restore ${name}: $($_.Exception.Message)" }
    }
    if (-not $Execute) { Write-Log "DRY RUN. Add -Execute to actually restore." }
    exit 0
}

# ---------------------------------------------------------------------------
# The laptop keeps ONLY what cannot run on the VPS, plus what watches the VPS.
# Everything that computes signals, trades, researches, or compares the two boxes
# is duplication and gets disabled.
# ---------------------------------------------------------------------------
$KEEP = @(
    # Local plumbing - the server, the desktop, the session
    'SmartEntryPro',
    'SmartEntry Ensure Running',
    'SmartEntry Server Guard',
    'SmartEntry Stay Awake',
    'SmartEntry Morning Ready',
    # The ONE capability that genuinely does not work on the VPS: its tv_daily_plan
    # exits 5 with "Plan drawn: none | FAILED: BTC, GOLD, SPX" because the two boxes
    # fight over the same TradingView layout. With one drawer, this one wins cleanly.
    'SmartEntry TV Daily Plan',
    # The vault and the backups live on this box
    'SmartEntry Brain Sync',
    'SmartEntryVaultBackup',
    'SmartEntry Data Backup',
    'SmartEntry Mirror To USB',
    # Watching the one remaining node, and this box's own crash record
    'SmartEntry Crash Forensics',
    'SmartEntryVpsMonitor',
    'SmartEntryVPSBackupPull'
)

# Held back until the laptop's book is flat. These are the only tasks that can touch
# an open position, so they are the only ones that must not be disabled early.
$HOLD_UNTIL_FLAT = @(
    'SmartEntry Executor TK',
    'SmartEntry Executor CRT',
    'SmartEntry Executor FVG'
)

$all = @(Get-ScheduledTask | Where-Object {
    ($_.TaskName -like 'SmartEntry*' -or $_.TaskName -like 'JARVIS*') -and $_.State -ne 'Disabled'
})

$toDisable = @($all | Where-Object { $_.TaskName -notin $KEEP -and $_.TaskName -notin $HOLD_UNTIL_FLAT })
$held      = @($all | Where-Object { $_.TaskName -in $HOLD_UNTIL_FLAT })

Write-Log "consolidate_to_vps  box=$env:COMPUTERNAME  execute=$Execute  phase2=$Phase2"
Write-Log "  enabled SmartEntry/JARVIS tasks: $($all.Count)"
Write-Log "  keep enabled:                    $(@($all | Where-Object { $_.TaskName -in $KEEP }).Count)"
Write-Log "  disable now:                     $($toDisable.Count)"
Write-Log "  held for phase 2 (open book):    $($held.Count)"

# ---------------------------------------------------------------------------
# PHASE 2 - only once the laptop's book is flat.
# ---------------------------------------------------------------------------
if ($Phase2) {
    try {
        $pos = Invoke-RestMethod -Uri $PosUrl -TimeoutSec 8 -ErrorAction Stop
    } catch {
        Write-Log "REFUSING: cannot read $PosUrl ($($_.Exception.Message)). Not disarming blind."
        exit 2
    }
    $ours = @($pos.positions)
    if ($ours.Count -gt 0) {
        Write-Log "REFUSING: $($ours.Count) position(s) still open on this box:"
        foreach ($p in $ours) { Write-Log "    $($p.symbol) $($p.type) $($p.volume) profit=$($p.profit)" }
        Write-Log "  The executors also run the trailing stop. Disabling them now would leave"
        Write-Log "  these unmanaged. Re-run -Phase2 when the book is flat."
        exit 3
    }
    Write-Log "  book is FLAT - safe to disarm the executors."
    $toDisable = $held
}

if ($toDisable.Count -eq 0) { Write-Log "Nothing to do."; exit 0 }

# ---------------------------------------------------------------------------
# Export EVERY task on the box before changing one of them. Standing rule 4:
# the backup is written and VERIFIED TO EXIST before the change runs.
# ---------------------------------------------------------------------------
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup  = Join-Path $BackupRoot $stamp

if ($Execute) {
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    $exported = 0
    foreach ($t in $all) {
        $safe = $t.TaskName -replace '[\\/:*?"<>|]', '_'
        $out  = Join-Path $backup "$safe.xml"
        [System.IO.File]::WriteAllText($out, (Export-ScheduledTask -TaskName $t.TaskName), (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path $out) { $exported++ } else { Write-Log "BACKUP FAILED for $($t.TaskName)"; exit 4 }
    }
    if ($exported -ne $all.Count) { Write-Log "REFUSING: exported $exported of $($all.Count). Not proceeding."; exit 4 }
    Write-Log "  exported $exported task definition(s) -> $backup"
    Write-Log "  restore ALL with: powershell -File tasks\consolidate_to_vps.ps1 -Restore `"$backup`" -Execute"
}

$done = 0; $failed = 0
foreach ($t in ($toDisable | Sort-Object TaskName)) {
    if (-not $Execute) { Write-Log "  would disable: $($t.TaskName)"; continue }
    try {
        Disable-ScheduledTask -TaskName $t.TaskName -ErrorAction Stop | Out-Null
        $done++
    } catch {
        Write-Log "  FAILED: $($t.TaskName) -- $($_.Exception.Message)"
        $failed++
    }
}

if (-not $Execute) {
    Write-Log ""
    Write-Log "DRY RUN - nothing was changed. Add -Execute."
    Write-Log "These stay ENABLED:"
    foreach ($k in ($all | Where-Object { $_.TaskName -in $KEEP } | Sort-Object TaskName)) { Write-Log "    KEEP  $($k.TaskName)" }
    foreach ($h in ($held | Sort-Object TaskName)) { Write-Log "    HOLD  $($h.TaskName)  (phase 2, book not flat)" }
    exit 0
}

Write-Log "  disabled $done, failed $failed"

# Proof is the task state, not the exit code.
$stillOn = @(Get-ScheduledTask | Where-Object {
    ($_.TaskName -like 'SmartEntry*' -or $_.TaskName -like 'JARVIS*') -and $_.State -ne 'Disabled'
})
Write-Log "  enabled after: $($stillOn.Count)"
foreach ($s in ($stillOn | Sort-Object TaskName)) { Write-Log "    ON  $($s.TaskName)" }

if ($failed -gt 0) { exit 1 }
exit 0
