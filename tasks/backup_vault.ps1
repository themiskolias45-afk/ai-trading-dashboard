# ---------------------------------------------------------------------------
# Backs up the JARVIS vault - the memory.
#
# Until 2026-07-26 this had no protection of any kind: not a git repo, not copied
# anywhere, not in the VPS backup (which only covers the VPS). The vault is what
# makes a fresh session boot as the same colleague instead of a stranger, and it
# was living on exactly one disk with no second copy. Losing it loses every
# correction and decision recorded in it - the one thing in this system that
# cannot be rebuilt from code.
#
# Runs on the local machine, where the vault lives. Keeps 30 daily snapshots.
# Small enough (~128 KB) that keeping a month costs nothing.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'

function Get-Setting($envName, $default) {
    $value = [Environment]::GetEnvironmentVariable($envName)
    if ([string]::IsNullOrWhiteSpace($value)) { return $default }
    return $value
}

$vaultDir  = Get-Setting 'VAULT_BACKUP_SOURCE' 'C:\Users\User\Documents\Brain'
$backupDir = Get-Setting 'VAULT_BACKUP_DEST'   'C:\Users\User\Documents\Brain-backups'
$logFile   = Get-Setting 'VAULT_BACKUP_LOG'    'C:\Users\User\ai-trading-dashboard\tasks\logs\vault_backup.txt'

# RAISED 30 -> 120 on 2026-09-02, because the backup went from DAILY to every 4 hours.
# At 30 snapshots a 6-a-day cadence covers only FIVE DAYS of history - more frequent
# backups would have silently bought recency by spending depth, which is a loss
# dressed as an improvement. 120 keeps ~20 days at the new rate, and the arithmetic is
# not close: each snapshot is ~14 MB, the whole archive is 72.9 MB today, and the disk
# has 328 GB free. 120 x 14 MB is 1.7 GB.
#
# Rotation is also SKIPPED entirely whenever the graph check reports a regression or a
# too-small store, so a bad snapshot can never age out the good copies behind it.
$KEEP_SNAPSHOTS = 120

$logDir = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-VaultLog($message) {
    Add-Content -Path $logFile -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message) -ErrorAction SilentlyContinue
}

if (-not (Test-Path $vaultDir)) {
    Write-VaultLog ("SKIPPED - vault not found at " + $vaultDir)
    exit 1
}

if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }

# Don't archive our own backups if someone ever nests the dirs, and skip the .bak
# files the note-dedupe leaves behind.
$files = Get-ChildItem -Path $vaultDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike ($backupDir + '*') }

if (-not $files -or $files.Count -eq 0) {
    Write-VaultLog 'SKIPPED - vault contains no files'
    exit 1
}

# --- EXTRA ROOTS - added 2026-09-01 ----------------------------------------
# Until today this script protected the vault and NOTHING ELSE. An audit that day
# found the three most irreplaceable things on this laptop had no copy anywhere:
#
#   .claude\projects\...\memory   302 files, 1.9 MB. The file memory vault - the
#                                 rail that actually held every lesson while the
#                                 MCP graph was quietly being wiped. It lives under
#                                 ~/.claude, OUTSIDE the git repo, so "it is in git"
#                                 was never true for it.
#   tasks\rejections*.jsonl       2.5 MB. UNTRACKED - never git-added. The rejection
#                                 ledger, which is the evidence the whole
#                                 measurement strategy rests on.
#   server\journal.json           GITIGNORED. The actual trade history.
#
# The vault still lands at the ROOT of the zip, unchanged, so the graph guard below
# still finds mcp-memory.json at the top level and older snapshots stay comparable.
# Extra roots go under prefixes so nothing can collide. A missing root is logged and
# skipped - it must never stop a backup from being taken.
# NAMING FOUR FILES HERE WAS THE WRONG SHAPE. The first version of this listed
# rejections.jsonl, rejections_scored.jsonl, journal.json and strategy_settings.json
# by hand - and a sweep immediately afterwards found near_misses.jsonl,
# learning_shadow.json, agent_queue.jsonl, stop_variants.jsonl, tv_alerts.json,
# hermes_state.json, features.json, trading_control.json, everything under
# tasks\analysis, and part of tasks\daily all sitting outside it. An allowlist
# protects what you remembered; it silently drops whatever comes next. Same
# failure as the parity check's tracked-file allowlist.
#
# So the rule is by KIND, not by name: every .json / .jsonl / .db under tasks\ and
# server\, minus noise and minus secrets. A new state file is covered the day it
# is created, without anyone remembering to add it.
$DATA_EXTENSIONS  = @('.json', '.jsonl', '.db')
$DATA_MAX_BYTES   = 2MB
$DATA_SKIP_DIRS   = @('node_modules', 'logs', 'backups', '__pycache__', 'history', 'history_yahoo', 'screenshots')

# Secrets are excluded ON PURPOSE and must stay excluded: this zip is copied
# off-box to the VPS every run, and keys.env / apikey.txt / session_secret.txt
# are exactly the things that must not travel in it. They live on both machines
# already and are recreated, not restored.
$DATA_SKIP_NAMES  = @('keys.env', 'apikey.txt', 'session_secret.txt', 'package-lock.json')

function Test-DataFile($file) {
    if ($DATA_EXTENSIONS -notcontains $file.Extension.ToLower()) { return $false }
    if ($file.Length -gt $DATA_MAX_BYTES) { return $false }
    if ($file.Name -like '*.bak*') { return $false }
    foreach ($n in $DATA_SKIP_NAMES) { if ($file.Name -like ($n + '*')) { return $false } }
    foreach ($d in $DATA_SKIP_DIRS) { if ($file.FullName -like ('*\' + $d + '\*')) { return $false } }
    if ($file.FullName -like '*\_prerestart*') { return $false }
    return $true
}

$extraRoots = @(
    [pscustomobject]@{ Path = 'C:\Users\User\.claude\projects\C--Users-User-ai-trading-dashboard\memory'; Prefix = '_claude-memory'; DataOnly = $false },
    [pscustomobject]@{ Path = 'C:\Users\User\ai-trading-dashboard\tasks';  Prefix = '_repo-data\tasks';  DataOnly = $true },
    [pscustomobject]@{ Path = 'C:\Users\User\ai-trading-dashboard\server'; Prefix = '_repo-data\server'; DataOnly = $true },
    # ADDED 2026-09-02. dashboard/ was the LAST uncovered store, found by checking the
    # claim rather than accepting it: 11 data .json files on disk against TWO entries in
    # the archive.
    #
    # They ARE tracked in git, which is why nobody noticed - but git held STALE copies,
    # because these files are rewritten by every pipeline run and are almost never
    # committed. So the CURRENT state of durable-state.json, instrument-scan.json,
    # page-quality.json and the pipeline/weekly artifacts lived on exactly one disk.
    #
    # "They are regenerable" is the argument that kept them unprotected, and it is the
    # wrong argument: regenerable is not the same as present, regenerating needs the
    # pipelines that produced them, and the requirement is to lose NOTHING.
    #
    # DataOnly, so the html and js stay in git where they belong.
    [pscustomobject]@{ Path = 'C:\Users\User\ai-trading-dashboard\dashboard'; Prefix = '_repo-data\dashboard'; DataOnly = $true }
)

$items = New-Object System.Collections.ArrayList
foreach ($file in $files) {
    [void]$items.Add([pscustomobject]@{ Full = $file.FullName; Rel = $file.FullName.Substring($vaultDir.Length).TrimStart('\') })
}

foreach ($root in $extraRoots) {
    if (-not (Test-Path $root.Path)) {
        Write-VaultLog ('EXTRA ROOT MISSING - ' + $root.Path + ' (skipped; backup continues)')
        continue
    }
    $before = $items.Count
    Get-ChildItem -Path $root.Path -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        if ($root.DataOnly -and -not (Test-DataFile $_)) { return }
        $rel = $_.FullName.Substring($root.Path.Length).TrimStart('\')
        [void]$items.Add([pscustomobject]@{ Full = $_.FullName; Rel = (Join-Path $root.Prefix $rel) })
    }
    Write-VaultLog ('Extra root ' + $root.Prefix + ' -> ' + ($items.Count - $before) + ' file(s)')
}

$stamp   = Get-Date -Format 'yyyyMMdd_HHmmss'
$destZip = Join-Path $backupDir ('vault_' + $stamp + '.zip')

$added   = 0
$skipped = 0

try {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($destZip, [System.IO.Compression.ZipArchiveMode]::Create)

    foreach ($item in $items) {
        $relativePath = $item.Rel
        try {
            $entry  = $zip.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
            $stream = $entry.Open()
            # ReadWrite+Delete share so a note open in Obsidian can still be captured.
            $source = [System.IO.File]::Open($item.Full, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
            $source.CopyTo($stream)
            $source.Close()
            $stream.Close()
            $added++
        } catch {
            $skipped++
        }
    }

    $zip.Dispose()

    # Count files, not just bytes. A snapshot that silently captured half the vault
    # is the failure worth catching, and a KB figure hides it.
    $sizeKB = [math]::Round((Get-Item $destZip).Length / 1KB, 1)
    $line = 'Vault backup created: ' + (Split-Path $destZip -Leaf) + ' (' + $sizeKB + ' KB, ' + $added + ' files'
    if ($skipped -gt 0) { $line = $line + ', ' + $skipped + ' SKIPPED' }
    Write-VaultLog ($line + ')')
} catch {
    Write-VaultLog ('FAILED - ' + $_.Exception.Message)
    if (Test-Path $destZip) { Remove-Item $destZip -Force -ErrorAction SilentlyContinue }
    exit 1
}

# --- knowledge-graph regression guard -------------------------------------
# Added 2026-09-01 after the MCP knowledge graph was lost entirely. Until then it
# lived inside the npx package cache because MEMORY_FILE_PATH was never set,
# and npx re-extracting the package took the store with it. Nothing on this machine
# held a copy. It now lives in the vault, so the zip above captures it and the scp
# below puts it on the VPS too.
#
# But a backup with no content check turns a wipe into a PERMANENT loss: the empty
# file gets zipped just as happily as a full one, and 30 rotations later every
# surviving snapshot is empty. The rotation is the dangerous half, not the zip.
#
# So: count the entities, record the count every run, and if it has GONE DOWN
# against the newest previous snapshot - or the file has vanished - keep every
# snapshot instead of rotating. Deletes nothing, blocks nothing, and never
# prevents a backup: this runs AFTER the zip is already written, so a fault here
# costs the rotation, not the snapshot.
function Get-GraphEntityCount($jsonPath) {
    if (-not (Test-Path $jsonPath)) { return 0 }
    try {
        $n = 0
        foreach ($line in [System.IO.File]::ReadAllLines($jsonPath)) {
            if ($line -match '"type"\s*:\s*"entity"') { $n++ }
        }
        return $n
    } catch { return -1 }
}

$graphPath   = Join-Path $vaultDir 'mcp-memory.json'
$graphNow    = Get-GraphEntityCount $graphPath
$graphBefore = -1
$prevZip = Get-ChildItem (Join-Path $backupDir 'vault_*.zip') -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $destZip } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($prevZip) {
    try {
        Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
        $pz = [System.IO.Compression.ZipFile]::OpenRead($prevZip.FullName)
        $entry = $pz.Entries | Where-Object { $_.FullName -eq 'mcp-memory.json' } | Select-Object -First 1
        if ($entry) {
            $sr = New-Object System.IO.StreamReader($entry.Open())
            $txt = $sr.ReadToEnd(); $sr.Close()
            $graphBefore = ([regex]::Matches($txt, '"type"\s*:\s*"entity"')).Count
        } else {
            # No graph in the previous snapshot is EXPECTED for every zip taken
            # before 2026-09-01. Not a regression - there was nothing to lose yet.
            $graphBefore = -1
        }
        $pz.Dispose()
    } catch { $graphBefore = -1 }
}

# AN ABSOLUTE FLOOR, not just a direction. Added 2026-09-02.
#
# The comparison below is a REGRESSION detector: it fires when the count goes DOWN.
# That is the right test and it has a blind spot - a graph that is ALREADY empty never
# goes down. Measured: from 2026-09-01 to 2026-09-02 this logged
# `Graph OK - mcp-memory.json holds 1 entities (previous snapshot: 1)` on every run,
# while mcp__memory__search_nodes returned NOTHING for every term CLAUDE.md startup
# step 2b queries. 1 against 1 is not a decrease, so the check passed, and the word
# "OK" read as "the graph is fine" when it meant "it did not shrink today".
#
# It could not have caught the original loss either: the graph lived inside the npx
# cache until 09-01, so no snapshot ever held the pre-loss count to compare against.
# A relative test is blind on its first run by construction.
#
# 5 is deliberately low against the 42 entities held today. The floor exists to catch
# an EMPTY store, not to police the graph's size, and a threshold that fires on
# ordinary variation trains you to skim past it - the same failure the action-item
# rule in CLAUDE.md warns about. Like every other branch here it only ever KEEPS
# snapshots; it deletes nothing and never blocks a backup.
$GRAPH_MIN_ENTITIES = 5

$graphRegressed = $false
if ($graphNow -lt 0) {
    Write-VaultLog 'GRAPH WARNING - mcp-memory.json could not be read; keeping every snapshot'
    $graphRegressed = $true
} elseif ($graphNow -lt $GRAPH_MIN_ENTITIES) {
    Write-VaultLog ('GRAPH TOO SMALL - mcp-memory.json holds ' + $graphNow + ' entities, floor is ' + $GRAPH_MIN_ENTITIES + '. This is NOT a decrease and the regression check below would have passed it. A store this size means startup recall returns nothing - verify with mcp__memory__search_nodes before trusting it. KEEPING every snapshot.')
    $graphRegressed = $true
} elseif ($graphBefore -ge 0 -and $graphNow -lt $graphBefore) {
    Write-VaultLog ('GRAPH REGRESSION - mcp-memory.json holds ' + $graphNow + ' entities, previous snapshot had ' + $graphBefore + '. KEEPING every snapshot so the good copies cannot age out. Investigate before trusting the newest backup.')
    $graphRegressed = $true
} else {
    Write-VaultLog ('Graph no-decrease - mcp-memory.json holds ' + $graphNow + ' entities, at or above the floor of ' + $GRAPH_MIN_ENTITIES + ' (previous snapshot: ' + $(if ($graphBefore -lt 0) { 'none' } else { $graphBefore }) + '). This says the count did not fall; it does NOT say recall works.')
}

if ($graphRegressed) {
    Write-VaultLog ('Rotation SKIPPED this run - ' + (Get-ChildItem (Join-Path $backupDir 'vault_*.zip') -ErrorAction SilentlyContinue | Measure-Object).Count + ' snapshots retained')
} else {
    Get-ChildItem (Join-Path $backupDir 'vault_*.zip') -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $KEEP_SNAPSHOTS |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

# --- push a copy off this machine ------------------------------------------
# The vault lives on this PC, so a snapshot that also lives on this PC protects
# against a bad edit but not against losing the machine. The VPS is the only other
# box that is always on, so the newest snapshot goes there too. Best-effort: if the
# VPS is unreachable the local snapshot has already been written and is still good.
$sshKey     = 'C:\Users\User\.ssh\contabo_smartentry'
$vpsTarget  = 'administrator@169.58.74.133'
$vpsDestDir = 'C:/vault-backups'

if (Test-Path $sshKey) {
    try {
        # ssh.exe/scp.exe by full name with an argument ARRAY. Calling them as
        # bare "ssh -i ..." lets PowerShell's parameter binder try to interpret
        # -i itself, which fails with a confusing complaint about inputFormat.
        $sshOpts = @('-i', $sshKey, '-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes')

        $mkdirCmd = 'if not exist "' + ($vpsDestDir -replace '/', '\') + '" mkdir "' + ($vpsDestDir -replace '/', '\') + '"'
        & ssh.exe @sshOpts $vpsTarget $mkdirCmd 2>&1 | Out-Null

        # Capture into a variable rather than piping to Out-Null: a pipeline
        # resets $LASTEXITCODE, so the old check reported failure on a copy that
        # had actually succeeded.
        $scpOutput = & scp.exe @sshOpts $destZip ($vpsTarget + ':' + $vpsDestDir + '/') 2>&1
        $scpExit   = $LASTEXITCODE

        if ($scpExit -eq 0) {
            Write-VaultLog ('Copied off-box to VPS ' + $vpsDestDir)
            # Keep the same depth off-box as on it.
            $rotateCmd = 'powershell -NoProfile -Command "Get-ChildItem ' + $vpsDestDir + '/vault_*.zip -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip ' + $KEEP_SNAPSHOTS + ' | Remove-Item -Force -ErrorAction SilentlyContinue"'
            & ssh.exe @sshOpts $vpsTarget $rotateCmd 2>&1 | Out-Null
        } else {
            Write-VaultLog ('VPS copy failed (exit ' + $scpExit + ': ' + ($scpOutput -join ' ') + ') - local snapshot is still good')
        }
    } catch {
        Write-VaultLog ('VPS copy error - ' + $_.Exception.Message + ' (local snapshot still good)')
    }
} else {
    Write-VaultLog 'No SSH key - skipped off-box copy'
}
