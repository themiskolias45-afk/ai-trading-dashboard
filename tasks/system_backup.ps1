# One archive for the WHOLE fleet: this box in full, plus a snapshot of the peer.
#
#   powershell -File tasks\system_backup.ps1 [-VpsSnapshot <path>] [-OutDir <path>]
#
# ASCII ONLY: PowerShell 5.1 reads a .ps1 as ANSI without a BOM, so a stray em-dash
# arrives carrying a quote character and the file stops parsing.
#
# WHY THIS EXISTS AND WHAT IT REFUSES TO OMIT
# The previous archive of this system was JARVIS-SYSTEM-BACKUP-20260725-1701.zip and it
# covered ONE box. This fleet is two, and the other one holds things this box has never
# had: analysis and patch scripts that exist only there, its own untracked
# strategy_settings.json (per-machine BY DESIGN, so a shared commit does NOT mean shared
# behaviour), and its own journal.json and learning.json describing DIFFERENT trades.
# An archive of this box alone would look complete and quietly lose all of it.
#
# .git is INCLUDED. The previous archive dropped it, which meant the entire commit
# history depended on GitHub surviving. A backup that needs a third party to be intact
# is not a backup.
#
# node_modules is included from this box only. It is npm-restorable from
# package-lock.json, and the peer's copy is the same dependency tree, so shipping it
# twice would roughly double the archive for nothing.
#
# CONTAINS CREDENTIALS. keys.env, server/apikey.txt and the peer's equivalents are all
# inside, because this is a RESTORE artifact and a restore without them produces a
# system that cannot log in, cannot reach its peer and cannot talk to the broker. That
# is a deliberate trade: this file must never be emailed, uploaded, or put anywhere
# shared. The manifest inside says so too, so the warning travels with the archive.

param(
  [string]$VpsSnapshot = "",
  [string]$OutDir = "$env:USERPROFILE\Desktop"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$outFile = Join-Path $OutDir ("JARVIS-SYSTEM-BACKUP-" + $stamp + ".zip")

$staging = Join-Path $env:TEMP ("sysbak_" + [Guid]::NewGuid().ToString("N").Substring(0,8))
$localDir = Join-Path $staging "laptop"
New-Item -ItemType Directory -Path $localDir -Force | Out-Null

try {
    Write-Host "collecting this box..."
    $files = Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue
    $copied = 0; $skipped = 0
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($root.Length).TrimStart('\')
        $dest = Join-Path $localDir $rel
        $dir = Split-Path $dest -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        # A locked file must not abort the archive. The SQLite WAL and any open log are
        # routinely busy here, and a backup that fails wholesale because one file was in
        # use is worse than one that records which file it could not read.
        try { Copy-Item $f.FullName -Destination $dest -Force -ErrorAction Stop; $copied++ }
        catch { Add-Content -Path (Join-Path $staging "_UNREADABLE.txt") -Value $rel -Encoding utf8; $skipped++ }
    }
    Write-Host ("  {0} files copied, {1} unreadable" -f $copied, $skipped)

    $vpsNote = "NOT INCLUDED - the peer snapshot was not supplied to this run"
    if ($VpsSnapshot -and (Test-Path $VpsSnapshot)) {
        Copy-Item $VpsSnapshot -Destination (Join-Path $staging "vps-snapshot.zip") -Force
        $vpsMb = [math]::Round((Get-Item $VpsSnapshot).Length / 1MB, 1)
        $vpsNote = "vps-snapshot.zip ($vpsMb MB) - the peer's entire project except node_modules"
        Write-Host ("  peer snapshot included ({0} MB)" -f $vpsMb)
    } else {
        Write-Host "  WARNING: no peer snapshot supplied - this archive covers ONE box"
    }

    $gitHead = ""
    try { $gitHead = (& git -C $root rev-parse HEAD 2>$null) } catch {}
    $branch = ""
    try { $branch = (& git -C $root rev-parse --abbrev-ref HEAD 2>$null) } catch {}

    $manifest = @(
        "JARVIS / SmartEntry Pro - FULL FLEET BACKUP",
        "created            : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')",
        "",
        "*** THIS ARCHIVE CONTAINS CREDENTIALS ***",
        "keys.env, server/apikey.txt and the peer's equivalents are inside, because a",
        "restore without them yields a system that cannot log in, cannot reach its peer",
        "and cannot talk to the broker. Never email, upload or share this file.",
        "",
        "CONTENTS",
        "  laptop/            this box in full, INCLUDING .git and node_modules",
        "  $vpsNote",
        "  _UNREADABLE.txt    files locked at backup time, if any (absent = none)",
        "",
        "THE FLEET IS TWO BOXES",
        "  laptop : $root",
        "  peer   : C:\ai-trading-dashboard on 169.58.74.133 (Contabo)",
        "The peer holds analysis and patch scripts that exist ONLY there, its own",
        "untracked strategy_settings.json (per-machine by design), and its own",
        "journal.json and learning.json describing DIFFERENT trades. An archive of one",
        "box looks complete and is not.",
        "",
        "GIT",
        "  branch : $branch",
        "  HEAD   : $gitHead",
        "  .git is included, so history does not depend on GitHub surviving.",
        "",
        "RESTORE",
        "  1. unzip laptop/ to the project path above",
        "  2. npm install in server/ and mcp-smartentry/ if node_modules is stale",
        "  3. unzip vps-snapshot.zip onto the peer at C:\ai-trading-dashboard",
        "  4. strategy_settings.json is PER MACHINE - do not copy one box's over the other",
        "  5. verify with: node tasks/doctor.cjs   and   node tasks/vps_parity.cjs --emit"
    ) -join "`r`n"
    Set-Content -Path (Join-Path $staging "MANIFEST.txt") -Value $manifest -Encoding utf8

    if (Test-Path $outFile) { Remove-Item $outFile -Force }
    Write-Host "compressing..."
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $outFile)
    $mb = [math]::Round((Get-Item $outFile).Length / 1MB, 1)
    Write-Host ""
    Write-Host ("WROTE {0}" -f $outFile)
    Write-Host ("  {0} MB" -f $mb)
    if ($skipped -gt 0) { Write-Host ("  {0} file(s) were locked - see _UNREADABLE.txt inside" -f $skipped) }
} finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
