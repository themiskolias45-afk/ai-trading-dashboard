$ErrorActionPreference = "Continue"
$backupDir = "C:\ai-trading-dashboard-backups"
$logFile   = "C:\ai-trading-dashboard\tasks\logs\backup_log.txt"
$errFile   = "C:\ai-trading-dashboard\tasks\logs\backup_errors.txt"

if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$destZip = Join-Path $backupDir "backup_$stamp.zip"

$candidates = @(
  "C:\ai-trading-dashboard\server\journal.json",
  "C:\ai-trading-dashboard\server\learning.json",
  "C:\ai-trading-dashboard\server\smartentry.db",
  "C:\ai-trading-dashboard\tasks\logs"
)
$existing = $candidates | Where-Object { Test-Path $_ }

# --- Code, not just data ----------------------------------------------------
# This backup used to capture learning.json, the SQLite db and the logs, and
# nothing else. Restoring it onto a fresh box would have handed you the data with
# no server to run it - and on 2026-07-26 four of the VPS's own task scripts were
# found living on this disk and nowhere else. Code is now included at its real
# relative path, so a restore reproduces the tree.
#
# node_modules is excluded on purpose: ~98MB that `npm install` rebuilds from
# package.json. Secrets are excluded on purpose too - keys.env and apikey.txt are
# restored from wherever they are kept, never from a rotating zip that gets copied
# off this box.
$projectRoot    = "C:\ai-trading-dashboard"
$secretNames    = @("keys.env", "keys.env.bak", "apikey.txt")
$excludedDirs   = @("node_modules", "__pycache__", ".git")
$codeExtensions = @(".js", ".py", ".bat", ".ps1", ".json", ".md", ".html", ".css", ".pine")

$codeFiles = Get-ChildItem -Path $projectRoot -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
  $relativePath = $_.FullName.Substring($projectRoot.Length + 1)
  ($codeExtensions -contains $_.Extension.ToLower()) -and
  ($secretNames -notcontains $_.Name) -and
  (-not ($excludedDirs | Where-Object { $relativePath -like "*$_\*" }))
}

# Copies one file into the open zip under the given entry name.
# Returns $true on success. Shares ReadWrite+Delete so a log file that the server
# is actively writing to can still be captured.
function Add-FileToZip($zipArchive, $sourcePath, $entryName) {
  try {
    $entry  = $zipArchive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    $source = [System.IO.File]::Open($sourcePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    $source.CopyTo($stream)
    $source.Close()
    $stream.Close()
    return $true
  } catch {
    return $false
  }
}

try {
  if ($existing.Count -eq 0 -and $codeFiles.Count -eq 0) {
    throw "No candidate files or folders exist yet - nothing to back up"
  }

  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::Open($destZip, [System.IO.Compression.ZipArchiveMode]::Create)

  $added   = 0
  $skipped = 0

  foreach ($item in $existing) {
    if (Test-Path $item -PathType Container) {
      $base = Split-Path $item -Leaf
      Get-ChildItem -Path $item -Recurse -File | ForEach-Object {
        $rel = $base + "\" + $_.FullName.Substring($item.Length + 1)
        if (Add-FileToZip $zip $_.FullName $rel) { $added++ } else { $skipped++ }
      }
    } else {
      $name = Split-Path $item -Leaf
      if (Add-FileToZip $zip $item $name) { $added++ } else { $skipped++ }
    }
  }

  foreach ($file in $codeFiles) {
    $relativePath = $file.FullName.Substring($projectRoot.Length + 1)
    if (Add-FileToZip $zip $file.FullName $relativePath) { $added++ } else { $skipped++ }
  }

  $zip.Dispose()

  # Count the files, not just the size. A backup that silently captured half of
  # what it should is the failure mode worth catching, and a KB figure hides it.
  $sizeKB = [math]::Round((Get-Item $destZip).Length / 1KB, 1)
  $line = "[" + (Get-Date) + "] Backup created: " + (Split-Path $destZip -Leaf) + " (" + $sizeKB + " KB, " + $added + " files"
  if ($skipped -gt 0) { $line = $line + ", " + $skipped + " SKIPPED" }
  $line = $line + ")"
  Add-Content -Path $logFile -Value $line
  if ($skipped -gt 0) {
    Add-Content -Path $errFile -Value ("[" + (Get-Date) + "] " + $skipped + " file(s) could not be read into the backup")
  }
} catch {
  $errLine = "[" + (Get-Date) + "] " + $_.Exception.Message
  Add-Content -Path $errFile -Value $errLine
  Add-Content -Path $logFile -Value ("[" + (Get-Date) + "] Backup FAILED - see backup_errors.txt")
}

Get-ChildItem "$backupDir\*.zip" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 14 |
  Remove-Item -Force -ErrorAction SilentlyContinue
