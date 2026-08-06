# Rotates the VPS's append-mode logs so an unattended box cannot fill its disk.
#
# server_log.txt reached 15.6 MB against the laptop's 249 KB with nothing ever
# truncating it, and bridge_log_A.txt ~2 MB. Beyond disk, size alone makes the logs
# unusable - extracting one day from bridge_log_A meant paging 21,178 lines.
#
# SAFE TO RUN WHILE THE SERVER AND BRIDGE ARE LIVE. Both are launched by cmd with
# `>> file 2>&1`, which opens the handle with FILE_APPEND_DATA: every write goes to
# the current EOF, so truncating to zero simply means the next line lands at offset
# 0. Renaming or deleting the open file instead would break the writer's handle or
# leave it appending to an unlinked inode - which is why this copies-then-truncates
# rather than moving anything.
#
# DELETION POLICY: the original log is never deleted, only truncated AFTER its
# contents have been copied to an archive. Pruning applies solely to archives this
# script itself created (the .1/.2/.3 generations). No trade, learning, journal or
# memory data is touched.

# ThresholdMB is a parameter so the rotation path can actually be exercised on
# demand. A size-triggered script that never trips its own threshold in testing is
# untested code sitting in the one place that only runs when the disk is filling.
param(
    [double] $ThresholdMB = 20,
    [int]    $Generations = 3,

    # Measured 2026-08-06: cmd's `>> file` opens with FILE_SHARE_READ only - NOT
    # share-write - so SetLength(0) on the live server_log.txt fails with "being used
    # by another process". Copy-then-truncate therefore cannot work under a running
    # server, whatever the append-mode theory says.
    #
    # With this switch, a lock failure escalates to: stop the writer, truncate,
    # start it again. Off by default so an ad-hoc run never restarts anything; the
    # daily task turns it on, at 04:30, and only for logs actually over threshold.
    [switch] $RestartServerIfLocked
)

$ErrorActionPreference = 'Continue'

$logDir       = 'C:\ai-trading-dashboard\tasks\logs'
$rotateLog    = Join-Path $logDir 'rotate_logs.txt'
$thresholdMB  = $ThresholdMB
$generations  = $Generations

$targets = @('server_log.txt', 'bridge_log_A.txt', 'bridge_log_B.txt', 'watchdog_log.txt', 'ensure_running.txt')

function Note($m) {
    Add-Content -Path $rotateLog -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m)
}

function Copy-OpenFile([string]$path, [string]$dest) {
    # FileShare.ReadWrite|Delete so a live writer is never blocked by this read.
    $src = [System.IO.File]::Open($path, [System.IO.FileMode]::Open,
                                  [System.IO.FileAccess]::Read,
                                  [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    try {
        $out = [System.IO.File]::Create($dest)
        try { $src.CopyTo($out) } finally { $out.Dispose() }
    } finally { $src.Dispose() }
}

function Clear-OpenFile([string]$path) {
    # SetLength(0) on a shared handle. Works precisely because the writers are in
    # append mode; with a positioned handle this would leave a null-padded file.
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open,
                                 [System.IO.FileAccess]::Write,
                                 [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    try { $fs.SetLength(0) } finally { $fs.Dispose() }
}

Note '--- rotation pass ---'

foreach ($name in $targets) {
    $path = Join-Path $logDir $name
    if (-not (Test-Path $path)) { continue }

    $sizeMB = [math]::Round((Get-Item $path).Length / 1MB, 2)
    if ($sizeMB -lt $thresholdMB) {
        Note ("$name is ${sizeMB} MB - under ${thresholdMB} MB, left alone")
        continue
    }

    try {
        # Age the existing generations. Only files this script created are removed.
        $oldest = "$path.$generations"
        if (Test-Path $oldest) { Remove-Item $oldest -Force }
        for ($i = $generations - 1; $i -ge 1; $i--) {
            $from = "$path.$i"
            if (Test-Path $from) { Move-Item $from "$path.$($i + 1)" -Force }
        }

        Copy-OpenFile $path "$path.1"
        $archived = [math]::Round((Get-Item "$path.1").Length / 1MB, 2)

        try {
            Clear-OpenFile $path
        } catch {
            if (-not $RestartServerIfLocked) {
                # Archive is already written, so drop it rather than leave a duplicate
                # of a log that was never truncated. Only removes what this run created.
                Remove-Item "$path.1" -Force -ErrorAction SilentlyContinue
                throw
            }

            Note ("$name is write-locked - stopping the writer to truncate")
            $writer = if ($name -eq 'server_log.txt') { 'SmartEntryServer' }
                      elseif ($name -like 'bridge_log_*') { 'SmartEntryBridgeA' }
                      else { $null }
            if (-not $writer) { Remove-Item "$path.1" -Force -ErrorAction SilentlyContinue; throw }

            schtasks /end /tn $writer 2>&1 | Out-Null
            Start-Sleep -Seconds 3
            if ($writer -eq 'SmartEntryServer') {
                Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
                    Where-Object { $_.CommandLine -like '*ai-trading-dashboard*' } |
                    ForEach-Object { & taskkill /F /PID $_.ProcessId 2>&1 | Out-Null }
            }
            Start-Sleep -Seconds 3

            Clear-OpenFile $path
            Note ("$name truncated; restarting $writer")
            schtasks /run /tn $writer 2>&1 | Out-Null
            Start-Sleep -Seconds 20

            try {
                $h = Invoke-RestMethod 'http://localhost:3001/api/healer' -TimeoutSec 15
                Note ("$writer back up, healthy=" + $h.healthy)
            } catch {
                Note ("WARNING: $writer did not answer after restart - " + $_.Exception.Message)
            }
        }

        $after = (Get-Item $path).Length
        Note ("$name rotated: ${sizeMB} MB -> archived ${archived} MB to $name.1, live file now $after bytes")
    } catch {
        Note ("$name ROTATION FAILED - " + $_.Exception.Message + " (log left untouched)")
    }
}

Note '--- pass complete ---'
