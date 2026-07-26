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

try {
  if ($existing.Count -eq 0) {
    throw "No candidate files or folders exist yet - nothing to back up"
  }

  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::Open($destZip, [System.IO.Compression.ZipArchiveMode]::Create)

  foreach ($item in $existing) {
    if (Test-Path $item -PathType Container) {
      $base = Split-Path $item -Leaf
      Get-ChildItem -Path $item -Recurse -File | ForEach-Object {
        $rel = $base + "\" + $_.FullName.Substring($item.Length + 1)
        try {
          $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
          $es = $entry.Open()
          $fs = [System.IO.File]::Open($_.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
          $fs.CopyTo($es)
          $fs.Close()
          $es.Close()
        } catch {}
      }
    } else {
      $name = Split-Path $item -Leaf
      try {
        $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $entry.Open()
        $fs = [System.IO.File]::Open($item, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
        $fs.CopyTo($es)
        $fs.Close()
        $es.Close()
      } catch {}
    }
  }
  $zip.Dispose()

  $sizeKB = [math]::Round((Get-Item $destZip).Length / 1KB, 1)
  $line = "[" + (Get-Date) + "] Backup created: " + (Split-Path $destZip -Leaf) + " (" + $sizeKB + " KB)"
  Add-Content -Path $logFile -Value $line
} catch {
  $errLine = "[" + (Get-Date) + "] " + $_.Exception.Message
  Add-Content -Path $errFile -Value $errLine
  Add-Content -Path $logFile -Value ("[" + (Get-Date) + "] Backup FAILED - see backup_errors.txt")
}

Get-ChildItem "$backupDir\*.zip" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 14 |
  Remove-Item -Force -ErrorAction SilentlyContinue
