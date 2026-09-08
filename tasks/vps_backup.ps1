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
  "C:\ai-trading-dashboard\tasks\logs",
  # The agent memory vault. It lives under the user profile, OUTSIDE $projectRoot, so
  # the recursive sweep below has never once seen it - 455 files on this box with no
  # copy anywhere. The same blind spot the laptop had for its own .claude memory, found
  # the same day.
  "C:\Users\Administrator\.claude\projects"
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
# .venv-rag and .venv added 2026-09-02. A Python virtualenv was created on this box on
# 09-01 for the RAG index, and the sweep below matches on EXTENSION, so its .py/.json/.md
# files were all eligible. The nightly archive went 40 MB / 1,455 files on 09-01 to
# 119 MB / 18,634 files on 09-02 - 15,016 of those files and 263 MB uncompressed were
# .venv-rag alone. That is the same argument node_modules is excluded under: pip
# rebuilds it from requirements, so it costs 3x the archive and 13x the file count every
# night to store nothing a restore needs.
#
# Plain `.venv` is listed beside it although no such directory exists here yet. The
# next venv on this box will almost certainly use the conventional name, and an
# exclusion list that only knows the one directory that already hurt is the same shape
# as the extension allowlist two comments below, which dropped every ledger because
# .jsonl had not been thought of yet.
#
# NOTE: "projects" in $candidates is NOT this - that is the agent memory vault under the
# user profile, deliberately included, and it must stay.
$excludedDirs   = @("node_modules", "__pycache__", ".git", ".venv-rag", ".venv")
# INSTALLERS AND ARCHIVES ARE NOT DATA. Added 2026-09-02 after measuring what this zip is
# actually made of: tasks\logs\tailscale-setup.msi, ONE FILE, was 29.1 MB compressed - 65%
# of a 44.6 MB archive. It had been stored 15 times here and pulled to the laptop 21 times:
# roughly 1 GB across the fleet, all of it the same downloaded installer.
#
# This is the same argument as node_modules and .venv-rag, and it matters more now that
# the backup runs every 4h instead of daily: 6 x 29 MB a day to store a file that is
# re-downloadable in a minute and that a restore does not need. The VPS has 65 GB free,
# not 328 like the laptop.
#
# Extensions, not a filename, because the next installer someone parks in logs\ will have
# a different name - the mistake the .jsonl note below already records. The file itself is
# NOT deleted; it is simply not archived.
$excludedExts   = @(".msi", ".exe", ".zip", ".7z", ".iso", ".dmg", ".pkg")
# .jsonl and .db added 2026-09-01. Their absence meant the LEDGERS on the box that
# actually trades were protected by nothing at all: rejections.jsonl (1.24 MB),
# rejections_scored.jsonl (1.35 MB), near_misses.jsonl, ai_decisions.jsonl and
# strategy_search_ledger.jsonl. Every one of them sat outside this list and outside
# $candidates, so no backup on either box held them. An extension allowlist drops
# whatever format arrives next, exactly as the laptop's file allowlist did the same
# morning.
$codeExtensions = @(".js", ".py", ".bat", ".ps1", ".json", ".jsonl", ".db", ".md", ".html", ".css", ".pine")

$codeFiles = Get-ChildItem -Path $projectRoot -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
  $relativePath = $_.FullName.Substring($projectRoot.Length + 1)
  ($codeExtensions -contains $_.Extension.ToLower()) -and
  ($secretNames -notcontains $_.Name) -and
  (-not ($excludedDirs | Where-Object { $relativePath -like "*$_\*" }))
}

# Copies one file into the open zip under the given entry name.
# Returns $true on success. Shares ReadWrite+Delete so a log file that the server
# is actively writing to can still be captured.
# ONE UNREADABLE FILE USED TO ABORT THE WHOLE REST OF THE ARCHIVE.
#
# The catch below returned $false and left $stream -- the entry stream from
# $entry.Open() -- OPEN. A ZipArchive in Create mode permits exactly ONE open entry at a
# time, so the very next CreateEntry threw, and so did every one after it, forever.
#
# Measured 2026-09-08. On 09-03 at 09:22 a process wrote 21 files into tasks\logs whose
# names end in a TRAILING DOT (index.js.bak-unmanaged-20260903072257. and friends).
# Windows cannot open such a path, so File::Open threw on the first one reached and the
# archive died there:
#
#   09/03 07:00   38215.3 KB   5653 files                 <- last good backup
#   09/03 11:00     934.7 KB     98 files, 5681 SKIPPED   <- and every run since
#
# 28 of 78 runs, five days, while the log line still read "Backup created". The box that
# TRADES had no archived copy of its code, its ledgers or its agent memory vault that
# whole time -- the zip held journal.json, learning.json, smartentry.db and ~100 log
# files, and stopped mid-way through the logs folder.
#
# The fix is the finally, not a filter on the filename. Filtering trailing dots would fix
# these 21 files and nothing about the next unreadable file, and the failure mode is
# silent by construction. Now a file that cannot be read costs ONLY ITSELF: it leaves an
# empty stub entry and the archive continues.
function Add-FileToZip($zipArchive, $sourcePath, $entryName) {
  $stream = $null
  $source = $null
  try {
    $entry  = $zipArchive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    $source = [System.IO.File]::Open($sourcePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    $source.CopyTo($stream)
    return $true
  } catch {
    return $false
  } finally {
    # Both closes are guarded: a close that throws must not itself leak the other stream.
    if ($source) { try { $source.Close() } catch {} }
    if ($stream) { try { $stream.Close() } catch {} }
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
      # THIS is the sweep that pulled in the installer, not the code sweep below - that one
      # uses an extension ALLOWLIST and would never have matched .msi. This one takes a
      # named directory WHOLESALE, and tasks\logs happened to contain a 29.1 MB
      # tailscale-setup.msi. Filtered here, where the bloat actually enters.
      Get-ChildItem -Path $item -Recurse -File | Where-Object {
        $excludedExts -notcontains $_.Extension.ToLower()
      } | ForEach-Object {
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

# RETENTION 14 -> 48 (2026-09-02), 48 -> 104 (2026-09-08). Owner's call both times.
#
# 14 -> 48: this job went from DAILY to every 4h. At 6 runs a day, keeping 14 covers TWO
# AND A HALF DAYS. Raising the frequency without raising the count would have quietly
# traded away almost all the history - recency bought with depth, which is a loss wearing
# the costume of an improvement.
#
# 48 -> 104: MEASURED, not assumed. The comment above estimated 48 as "8 days" from an
# assumed 6 runs/day. The archives on disk say otherwise: 48 zips spanning
# backup_20260826_030002 -> backup_20260908_230002 is 13.8 days, so the real rate is
# 3.47/day. The estimate was off by a factor of 1.7 in the safe direction, but it was
# still an estimate presented as a figure - and the whole point of a retention number is
# knowing what window it actually buys.
#
# WHY 30 DAYS IS THE TARGET. bucket_audit.cjs proves the backup RAN; it cannot prove
# nothing was LOST, because an archive taken after a deletion faithfully preserves the
# deletion and passes every check afterwards. The only defence is holding an archive from
# BEFORE the loss, so retention IS the window in which a silent deletion can still be
# noticed. tasks/backup_history_check.cjs reports that window and refuses to imply
# anything about what lies beyond it.
#
# THE ARITHMETIC, measured on this box 2026-09-08:
#   3.47 archives/day x 30 days = 104.   Average archive 22.1 MB -> 2.25 GB.
#   Free on C: 62.7 GB. The cost is 3.6% of free space.
# The laptop bucket was raised to 180 the same day (tasks/pull_vps_backup.bat), which is
# ~30 days at ITS higher observed rate - so both boxes now hold the same window, and the
# copy still outlives the source.
#
# Raising a retention only ever deletes LESS, so this cannot lose an archive that the old
# value would have kept.
$KEEP_BACKUPS = 104
Get-ChildItem "$backupDir\*.zip" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $KEEP_BACKUPS |
  Remove-Item -Force -ErrorAction SilentlyContinue
