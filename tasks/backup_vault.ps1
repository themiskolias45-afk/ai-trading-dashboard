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

$KEEP_SNAPSHOTS = 30

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

$stamp   = Get-Date -Format 'yyyyMMdd_HHmmss'
$destZip = Join-Path $backupDir ('vault_' + $stamp + '.zip')

$added   = 0
$skipped = 0

try {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($destZip, [System.IO.Compression.ZipArchiveMode]::Create)

    foreach ($file in $files) {
        $relativePath = $file.FullName.Substring($vaultDir.Length).TrimStart('\')
        try {
            $entry  = $zip.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
            $stream = $entry.Open()
            # ReadWrite+Delete share so a note open in Obsidian can still be captured.
            $source = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
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

Get-ChildItem (Join-Path $backupDir 'vault_*.zip') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $KEEP_SNAPSHOTS |
    Remove-Item -Force -ErrorAction SilentlyContinue

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
            Write-VaultLog 'VPS copy failed - local snapshot is still good'
        }
    } catch {
        Write-VaultLog ('VPS copy error - ' + $_.Exception.Message + ' (local snapshot still good)')
    }
} else {
    Write-VaultLog 'No SSH key - skipped off-box copy'
}
