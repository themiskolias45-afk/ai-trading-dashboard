<#
    Mirror the laptop's irreplaceable files onto the USB stick, as PLAIN FILES.

    WHY THIS EXISTS. Measured 2026-09-08: Desktop, Downloads, Pictures and Videos had
    exactly ONE copy each, on the single physical disk in this machine. File History is
    Stopped, there is no second drive, and OneDrive is running but the user's folders are
    not in it - Desktop/Documents/Pictures all still resolve under C:\Users\User. The
    vault archives did not escape it either: all 62 of them sit on the same disk as the
    originals. Six hard power-cuts in 60 days is how filesystem damage starts, so one
    copy on one disk is the actual exposure - see
    the_laptop_dies_twice_a_month_and_the_evidence_expires.

    NO ZIPS, ON PURPOSE. The user asked not to have zip files everywhere, and he is right
    for this job: you cannot browse an archive, open a photo from it, or tell what is
    inside without unpacking. Everything here lands as an ordinary file, in an ordinary
    folder, openable straight off the stick by anything.

    IT CANNOT DELETE. There is no /MIR and no /PURGE anywhere in this script, deliberately.
    robocopy's mirror mode deletes whatever the source no longer has, which would make the
    backup forget things exactly as fast as the laptop does. A file you remove here STAYS
    on the stick. That means the backup only ever grows, and that is the intended trade.

    IT TOUCHES NOTHING ALREADY ON THE STICK. Everything is written under one folder,
    LAPTOP-BACKUP. The Android folder, the APK, the PDF and the 1.3 GB OTA zip already on
    D: are never read, moved or removed.

    IT FINDS THE STICK BY VOLUME SERIAL, NOT BY DRIVE LETTER. Letters are reassigned by
    Windows whenever something else is plugged in first; a backup that writes to "D:"
    because D: was right once is a backup that will one day write into the wrong disk.

    IT VERIFIES BY COUNTING, NOT BY EXIT CODE. On 2026-09-08 the VPS backup logged
    "Backup created" with rc=0 while capturing 105 of 13,700 files for five days. So this
    counts the files at the source and at the destination and reports the shortfall. A
    green exit code is not evidence.

      powershell -ExecutionPolicy Bypass -File tasks\mirror_to_usb.ps1
      powershell -ExecutionPolicy Bypass -File tasks\mirror_to_usb.ps1 -WhatIf   (dry run)
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # The SanDisk 28.6 GB stick, identified 2026-09-08. Pass another to use a different one.
    [string]$VolumeSerial = 'B63B1D80',
    [string]$BackupFolderName = 'LAPTOP-BACKUP'
)

$ErrorActionPreference = 'Stop'

# FAT32 refuses any single file of 4 GB or more. Nothing on this laptop currently exceeds
# it (checked: largest source file is well under), but a future 4K video would, and a
# backup that silently skips the one irreplaceable file is worse than no backup - so the
# skips are counted and named rather than swallowed.
$FAT32_MAX_FILE_BYTES = 4GB

function Write-Head { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

# --------------------------------------------------------------------------------------
# What gets copied. Each entry is a source and the folder name it lands in on the stick.
# The repo itself is deliberately absent: ai-trading-dashboard is in git, pushed to the
# remote, AND pulled onto the VPS, so it already has three copies. This script is for the
# things that have ONE.
# --------------------------------------------------------------------------------------
$Sources = @(
    [pscustomobject]@{ Name = 'Desktop';        Path = Join-Path $env:USERPROFILE 'Desktop' }
    [pscustomobject]@{ Name = 'Documents';      Path = Join-Path $env:USERPROFILE 'Documents' }
    [pscustomobject]@{ Name = 'Downloads';      Path = Join-Path $env:USERPROFILE 'Downloads' }
    [pscustomobject]@{ Name = 'Pictures';       Path = Join-Path $env:USERPROFILE 'Pictures' }
    [pscustomobject]@{ Name = 'Videos';         Path = Join-Path $env:USERPROFILE 'Videos' }
    [pscustomobject]@{ Name = 'Brain-vault';    Path = 'C:\Users\User\Documents\Brain' }
    [pscustomobject]@{ Name = 'Claude-memory';  Path = 'C:\Users\User\.claude\projects\C--Users-User-ai-trading-dashboard\memory' }
)

# --------------------------------------------------------------------------------------
# Find the stick by serial. Refuse rather than guess.
# --------------------------------------------------------------------------------------
Write-Head 'Locating the USB stick'
$volume = Get-CimInstance Win32_LogicalDisk |
          Where-Object { $_.VolumeSerialNumber -eq $VolumeSerial }

if (-not $volume) {
    Write-Host "USB stick with serial $VolumeSerial is not plugged in." -ForegroundColor Red
    Write-Host 'Nothing was copied and nothing was changed. Plug it in and run again.' -ForegroundColor Red
    exit 1
}
if ($volume.Count -gt 1) {
    Write-Host "More than one volume reports serial $VolumeSerial - refusing to guess." -ForegroundColor Red
    exit 1
}

$driveLetter = $volume.DeviceID
$freeGB      = [math]::Round($volume.FreeSpace / 1GB, 2)
Write-Host "Found at $driveLetter  ($($volume.FileSystem), $freeGB GB free)" -ForegroundColor Green

$destRoot = Join-Path "$driveLetter\" $BackupFolderName

# --------------------------------------------------------------------------------------
# Measure first, so "not enough room" is said BEFORE half a backup exists.
# --------------------------------------------------------------------------------------
Write-Head 'Measuring'
$totalBytes = 0
$totalFiles = 0
$oversize   = @()

foreach ($src in $Sources) {
    if (-not (Test-Path $src.Path)) {
        Write-Host ("  {0,-15} MISSING - skipped, and said so" -f $src.Name) -ForegroundColor Yellow
        continue
    }
    $files = Get-ChildItem $src.Path -Recurse -File -Force -ErrorAction SilentlyContinue
    $sum   = ($files | Measure-Object -Property Length -Sum)
    $totalBytes += $sum.Sum
    $totalFiles += $sum.Count
    $oversize   += $files | Where-Object { $_.Length -ge $FAT32_MAX_FILE_BYTES }
    Write-Host ("  {0,-15} {1,6} files  {2,8} MB" -f $src.Name, $sum.Count, [math]::Round($sum.Sum / 1MB))
}

Write-Host ("  TOTAL           {0,6} files  {1,8} MB" -f $totalFiles, [math]::Round($totalBytes / 1MB)) -ForegroundColor Cyan

if ($oversize.Count -gt 0) {
    Write-Host "`n  $($oversize.Count) file(s) are 4 GB or larger and CANNOT go on FAT32:" -ForegroundColor Yellow
    foreach ($f in $oversize) { Write-Host ("    {0} ({1} GB)" -f $f.FullName, [math]::Round($f.Length / 1GB, 2)) -ForegroundColor Yellow }
    Write-Host '  These will be skipped by the copy. They are NOT backed up by this run.' -ForegroundColor Yellow
}

if ($totalBytes -gt $volume.FreeSpace) {
    Write-Host "`nNot enough room: need $([math]::Round($totalBytes/1GB,2)) GB, have $freeGB GB." -ForegroundColor Red
    Write-Host 'Nothing was copied.' -ForegroundColor Red
    exit 1
}

if ($WhatIfPreference) {
    Write-Head 'DRY RUN'
    Write-Host "Would copy $totalFiles files into $destRoot. Nothing written." -ForegroundColor Yellow
    exit 0
}

# --------------------------------------------------------------------------------------
# Copy. /E all subfolders, /XO never overwrite a NEWER file on the stick with an older
# one, /FFT for FAT's 2-second timestamps (without it every file looks changed every
# run), /XJ so a junction cannot send robocopy round a loop. No /MIR. No /PURGE.
# --------------------------------------------------------------------------------------
Write-Head 'Copying'
$logFile = Join-Path $PSScriptRoot 'logs\usb_mirror.txt'
$logDir  = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$results = @()

foreach ($src in $Sources) {
    if (-not (Test-Path $src.Path)) { continue }
    $dest = Join-Path $destRoot $src.Name

    robocopy $src.Path $dest /E /XO /FFT /DST /XJ /R:1 /W:5 /NP /NDL /NFL `
             /LOG+:$logFile | Out-Null
    $code = $LASTEXITCODE

    # robocopy's exit code is a BITMASK, not an error number. 0-7 means it worked
    # (1=copied, 2=extra files present on the destination - which is normal and desired
    # here, because we never delete). 8 and above means at least one file genuinely
    # failed. Treating "non-zero" as failure would report every healthy run as broken.
    $ok = ($code -lt 8)
    $results += [pscustomobject]@{ Name = $src.Name; Code = $code; Ok = $ok; Dest = $dest }

    $colour = if ($ok) { 'Green' } else { 'Red' }
    Write-Host ("  {0,-15} robocopy rc={1} {2}" -f $src.Name, $code, $(if ($ok) { 'ok' } else { 'FAILED' })) -ForegroundColor $colour
}

# --------------------------------------------------------------------------------------
# VERIFY BY COUNTING. This is the step the VPS backup did not have.
# --------------------------------------------------------------------------------------
Write-Head 'Verifying - counting files at source and on the stick'
$allGood = $true

foreach ($src in $Sources) {
    if (-not (Test-Path $src.Path)) { continue }
    $dest = Join-Path $destRoot $src.Name

    $srcCount = (Get-ChildItem $src.Path -Recurse -File -Force -ErrorAction SilentlyContinue |
                 Where-Object { $_.Length -lt $FAT32_MAX_FILE_BYTES } | Measure-Object).Count
    $dstCount = if (Test-Path $dest) {
                    (Get-ChildItem $dest -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count
                } else { 0 }

    # The stick may legitimately hold MORE than the source - files deleted on the laptop
    # are kept here on purpose. Fewer is the only thing that means something went wrong.
    if ($dstCount -lt $srcCount) {
        $allGood = $false
        Write-Host ("  {0,-15} SHORT: {1} on the stick vs {2} at the source" -f $src.Name, $dstCount, $srcCount) -ForegroundColor Red
    } else {
        $extra = $dstCount - $srcCount
        $note  = if ($extra -gt 0) { " (+$extra kept from earlier runs)" } else { '' }
        Write-Host ("  {0,-15} {1} files{2}" -f $src.Name, $dstCount, $note) -ForegroundColor Green
    }
}

Write-Head 'Result'
if ($allGood -and ($results | Where-Object { -not $_.Ok }).Count -eq 0) {
    Write-Host "Every file is on the stick at $destRoot" -ForegroundColor Green
    Write-Host 'Plain files - open them straight off the stick, no unpacking.' -ForegroundColor Green
} else {
    Write-Host 'INCOMPLETE - read the lines above. Nothing on the laptop was changed.' -ForegroundColor Red
}
Write-Host "Log: $logFile"
if ($oversize.Count -gt 0) {
    Write-Host "$($oversize.Count) file(s) over 4 GB were NOT copied (FAT32 limit)." -ForegroundColor Yellow
}
