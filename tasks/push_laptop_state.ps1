<#
    Push the laptop's GITIGNORED trading state to the VPS.

    WHY THIS EXISTS. The backup regime was one-directional. The VPS archives itself every
    4h and the laptop pulls those archives, so the VPS is safe. Nothing carried the
    laptop's own data off this machine:

      backup_data.bat      copies TWO files (journal.json, learning.json) to
                           tasks\backups\ on the SAME DISK
      mirror_to_usb.ps1    correct and non-destructive, but the stick is not plugged in,
                           so it protects nothing on a schedule
      backup_vault.ps1     the Obsidian vault, ~128 KB, not the trading data

    AND THE FILES THAT MATTER ARE NOT IN GIT. mirror_to_usb.ps1 excludes the repo on the
    grounds that it "is in git, pushed to the remote, AND pulled onto the VPS, so it
    already has three copies". Measured 2026-09-08 with `git check-ignore`, six of the
    most important files are GITIGNORED and had exactly ONE copy:

      server\learning.json      the learning engine
      server\journal.json       the trade journal
      server\smartentry.db      the database
      tasks\rejections.jsonl    4,880 rows of self-learning
      tasks\crash_ledger.jsonl  71 crash records
      tasks\agent_audit.jsonl   per-tool-call agent audit

    They are gitignored for a real reason - per-box mutable state must not be tracked, or
    a `git pull` on the VPS revokes append permission and freezes the ledgers. That keeps
    them out of GIT. It is not a reason to leave them with one copy on a laptop that hard
    crashed three times on 2026-09-08.

    THE VPS COPY IS NOT THE SAME DATA. The VPS runs a different account with different
    trades, so its learning.json and journal.json are its own, never copies of these.

    WHAT IT DOES. scp each file into C:\laptop-state\ on the VPS, into a folder named for
    the day, plus a `latest` copy. It writes ONLY under that folder and touches nothing
    the VPS uses. It cannot affect VPS trading: nothing there reads C:\laptop-state.

    IT NEVER DELETES. No pruning, no rotation, no -Force removal anywhere. The remote copy
    only ever grows. Retention there is a separate decision, deliberately not taken here.

    IT VERIFIES BY SIZE, NOT BY EXIT CODE. scp returning 0 is not evidence the bytes
    landed - the VPS backup logged "Backup created" with rc=0 for five days while
    capturing 105 of 13,700 files. Every file is re-read from the VPS and its byte count
    compared against the source.

      powershell -ExecutionPolicy Bypass -File tasks\push_laptop_state.ps1
      powershell -ExecutionPolicy Bypass -File tasks\push_laptop_state.ps1 -DryRun
#>
param(
    [switch]$DryRun,
    [string]$RemoteRoot = 'C:/laptop-state'
)

$ErrorActionPreference = 'Continue'
$Repo = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $Repo 'tasks\logs\push_laptop_state.txt'

function Say([string]$t) {
    Write-Host $t
    try { Add-Content -Path $logFile -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $t) -ErrorAction SilentlyContinue } catch { }
}

# Exactly the gitignored set, plus the two biggest tracked ledgers. Tracked files are
# already on the remote via git, but they cost little here and a second path costs nothing.
$Files = @(
    'server\learning.json',
    'server\journal.json',
    'server\smartentry.db',
    'tasks\rejections.jsonl',
    'tasks\crash_ledger.jsonl',
    'tasks\agent_audit.jsonl',
    'tasks\all_trades_ledger.jsonl',
    'tasks\jarvis_memory.json'
)

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$day = Get-Date -Format 'yyyyMMdd'
Say ("push_laptop_state " + $(if ($DryRun) { '[DRY RUN]' } else { '[EXECUTE]' }) + " -> vps:" + $RemoteRoot)

$present = @()
foreach ($rel in $Files) {
    $full = Join-Path $Repo $rel
    if (-not (Test-Path $full)) { Say ("  SKIP (absent): " + $rel); continue }
    $len = (Get-Item $full).Length
    if ($len -eq 0) { Say ("  SKIP (empty, refusing to overwrite a good remote copy with 0 bytes): " + $rel); continue }
    $present += [pscustomobject]@{ Rel = $rel; Full = $full; Size = $len; Name = (Split-Path $rel -Leaf) }
}

if (-not $present.Count) { Say '  nothing to push'; exit 0 }
Say ("  " + $present.Count + " file(s), " + [math]::Round((($present | Measure-Object Size -Sum).Sum / 1MB), 2) + " MB")

if ($DryRun) {
    foreach ($f in $present) { Say ("  would push " + $f.Rel + "  (" + $f.Size + " bytes)") }
    Say '  DRY RUN - nothing sent.'
    exit 0
}

# One dated folder per run, so an overwrite can never destroy an earlier good copy.
$remoteDir = $RemoteRoot + '/' + $day + '/' + $stamp
& ssh -o BatchMode=yes -o ConnectTimeout=20 vps ("cmd /c mkdir """ + ($remoteDir -replace '/','\') + """ 2>nul") 2>&1 | Out-Null

$sent = 0; $failed = 0; $verified = 0
foreach ($f in $present) {
    & scp -o BatchMode=yes -o ConnectTimeout=25 $f.Full ("vps:" + $remoteDir + "/" + $f.Name) 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $sent++ } else { Say ("  FAILED to send " + $f.Rel); $failed++ }
    # The size AFTER its own copy. Four of these files are APPEND-ONLY LEDGERS that are
    # written while this runs, so the size measured up at the top is already history by
    # the time scp finishes. Captured per file, immediately after its own transfer, so
    # the window below is as tight as it can be.
    $post = $f.Size
    try { $post = (Get-Item $f.Full).Length } catch { }
    $f | Add-Member -NotePropertyName SizeAfter -NotePropertyValue $post -Force
}

# VERIFY BY READING BACK. An exit code is not evidence.
$probe = "$env:TEMP\pls_verify.ps1"
$lines = @("`$d = '" + ($remoteDir -replace '/','\') + "'")
$lines += 'if(Test-Path $d){ Get-ChildItem $d | ForEach-Object { Write-Output ($_.Name + "=" + $_.Length) } } else { Write-Output "MISSING_DIR" }'
$lines -join "`r`n" | Out-File $probe -Encoding utf8
& scp -o BatchMode=yes -o ConnectTimeout=20 $probe 'vps:C:/ai-trading-dashboard/tasks/pls_verify.ps1' 2>&1 | Out-Null
$remote = & ssh -o BatchMode=yes -o ConnectTimeout=25 vps 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\ai-trading-dashboard\tasks\pls_verify.ps1' 2>&1

$remoteSizes = @{}
foreach ($line in $remote) {
    $m = [regex]::Match([string]$line, '^(.+?)=(\d+)$')
    if ($m.Success) { $remoteSizes[$m.Groups[1].Value] = [int64]$m.Groups[2].Value }
}
foreach ($f in $present) {
    if ($remoteSizes.ContainsKey($f.Name) -and $remoteSizes[$f.Name] -eq $f.Size) { $verified++ }
    else { Say ("  NOT VERIFIED: " + $f.Name + " local=" + $f.Size + " remote=" + $(if ($remoteSizes.ContainsKey($f.Name)) { $remoteSizes[$f.Name] } else { 'absent' })) }
}

Say ("  sent " + $sent + ", failed " + $failed + ", VERIFIED BY SIZE " + $verified + " of " + $present.Count)
if ($verified -ne $present.Count) { Say '  INCOMPLETE - some files did not land. This is a failure, not a warning.'; exit 1 }
Say ('  all files verified on the VPS at ' + $remoteDir)
exit 0
