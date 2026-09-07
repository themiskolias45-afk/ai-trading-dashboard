# Snapshot this box's whole project into a single zip, for the fleet backup.
#
#   powershell -File tasks\vps_snapshot.ps1 [-OutFile <path>]
#
# ASCII ONLY: PowerShell 5.1 reads a .ps1 as ANSI without a BOM, so a stray em-dash
# arrives carrying a quote character and the file stops parsing.
#
# WHY THIS EXISTS
# "Back up the system" on this fleet means TWO boxes. The VPS holds things the laptop
# has never had: 22 analysis and patch scripts that exist only here, its own untracked
# strategy_settings.json (per-machine BY DESIGN), and its own journal.json and
# learning.json describing DIFFERENT trades. A laptop-only archive silently loses all
# of it, and would look complete.
#
# node_modules is excluded: it is npm-restorable from package-lock.json and is a
# straight duplicate of the copy already in the laptop half of the archive. Everything
# else is included, secrets and all, because this is a RESTORE artifact - see the
# warning the caller prints about never sharing it.

param([string]$OutFile = "C:\ai-trading-dashboard\vps-snapshot.zip")

$ErrorActionPreference = 'Stop'
$root = "C:\ai-trading-dashboard"
if (-not (Test-Path $root)) { Write-Host "no project at $root"; exit 1 }

$staging = Join-Path $env:TEMP ("vpssnap_" + [Guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    $files = Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -notmatch '\\node_modules\\' }
    Write-Host ("collecting {0} files" -f $files.Count)

    foreach ($f in $files) {
        $rel = $f.FullName.Substring($root.Length).TrimStart('\')
        $dest = Join-Path $staging $rel
        $dir = Split-Path $dest -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        # Locked files (the SQLite WAL, an open log) must not abort the whole snapshot:
        # a backup that fails entirely because one file was busy is worse than one that
        # records which file it could not read.
        try { Copy-Item $f.FullName -Destination $dest -Force -ErrorAction Stop }
        catch { Add-Content -Path (Join-Path $staging "_UNREADABLE.txt") -Value $rel -Encoding utf8 }
    }

    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $OutFile)
    $mb = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
    Write-Host ("wrote {0}  ({1} MB)" -f $OutFile, $mb)
    if (Test-Path (Join-Path $staging "_UNREADABLE.txt")) {
        Write-Host "NOTE: some files were locked and are listed in _UNREADABLE.txt inside the zip"
    }
} finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
