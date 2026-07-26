# Saves a brief session summary to the vault when JARVIS closes.
#
# This used to Add-Content unconditionally on every stop event. A single working
# day produced ~40 near-identical "JARVIS Session" blocks in one daily note, all
# quoting the same five commits, because stop fires far more often than the repo
# actually changes. The note stopped being a record and became noise, which
# defeats the point of the vault - a future session reading it learns nothing.
#
# Now it appends only when the newest commit is one the note has not already
# recorded. No new commits since the last write means nothing worth saying.
$ts     = Get-Date -Format 'yyyy-MM-dd HH:mm'
$today  = Get-Date -Format 'yyyy-MM-dd'
$vault  = 'C:\Users\User\Documents\Brain\01 - Daily Notes'
$note   = "$vault\$today.md"

if (-not (Test-Path $vault)) { return }

# Last 5 commits as session record
$commits = git -C 'C:\Users\User\ai-trading-dashboard' log --oneline -5 2>$null
if (-not $commits) { return }

# The newest commit's short hash is the dedupe key: if the note already mentions
# it, this session added nothing new to record.
$newestHash = ($commits | Select-Object -First 1).ToString().Split(' ')[0]
if (-not $newestHash) { return }

if (Test-Path $note) {
    $existing = Get-Content -Path $note -Raw -ErrorAction SilentlyContinue
    if ($existing -and $existing.Contains($newestHash)) { return }
}

$content = @"

## JARVIS Session - $ts
$($commits -join "`n")
"@

Add-Content -Path $note -Value $content -Encoding UTF8 -ErrorAction SilentlyContinue
