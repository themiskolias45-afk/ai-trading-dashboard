<#
    Mirror the laptop's irreplaceable files onto the USB stick, as PLAIN FILES.

    WHY THIS EXISTS. Measured 2026-09-08: Desktop, Downloads, Pictures and Videos had
    exactly ONE copy each, on the single physical disk in this machine. File History is
    Stopped, there is no second drive, and OneDrive is running but the user's folders are
    not in it. Worse, C:\Users\User\CrossDevice holds 33.3 GB pulled off his phone -
    5,722 photographs and 245 videos - with no other copy anywhere. Six hard power-cuts
    in 60 days is how filesystem damage starts, so one copy on one disk is the real
    exposure. See the_laptop_dies_twice_a_month_and_the_evidence_expires.

    NO ZIPS, ON PURPOSE. The user asked not to have zip files everywhere, and he is right
    for this job: you cannot browse an archive, open a photo from it, or tell what is
    inside without unpacking. Everything here lands as an ordinary file in an ordinary
    folder, openable straight off the stick.

    IT CANNOT DELETE. There is no /MIR and no /PURGE anywhere, deliberately. robocopy's
    mirror mode deletes whatever the source no longer has, which would make the backup
    forget things exactly as fast as the laptop does. A file removed on the laptop STAYS
    on the stick. The backup only ever grows; that is the intended trade.

    IT TOUCHES NOTHING ALREADY ON THE STICK. Everything is written under one folder,
    LAPTOP-BACKUP. The Android folder, the APK, the PDF and the 1.3 GB OTA zip already
    there are never read, moved or removed.

    IT FINDS THE STICK BY VOLUME SERIAL, NOT BY DRIVE LETTER. Letters are reassigned
    whenever something else is plugged in first; a backup that writes to "D:" because D:
    was right once will one day write into the wrong disk.

    IT DOES NOT PRETEND TO FIT. Everything asked for is 33.5 GB against 22.7 GB free.
    That gap is real, so sources are taken in order of how irreplaceable they are, each
    is checked against the space ACTUALLY LEFT at that moment, and whatever does not fit
    is named on screen and written to NOT-BACKED-UP.txt on the stick. The failure being
    designed against is the VPS backup that logged "Backup created" with rc=0 while
    capturing 105 of 13,700 files for five days.

    IT VERIFIES BY COUNTING, at the source and on the stick. A green exit code is not
    evidence.

      powershell -ExecutionPolicy Bypass -File tasks\mirror_to_usb.ps1
      powershell -ExecutionPolicy Bypass -File tasks\mirror_to_usb.ps1 -DryRun

    -DryRun is a plain switch rather than PowerShell's -WhatIf on purpose: -WhatIf
    propagates into module auto-loading, so the first Get-CimInstance printed a dozen
    "What if: Performing the operation Set Alias" lines ahead of the real output. A dry
    run whose own noise buries its answer is not a dry run.
#>

param(
    # The SanDisk 28.6 GB stick, identified 2026-09-08. Pass another to use a different one.
    [string]$VolumeSerial = 'B63B1D80',
    [string]$BackupFolderName = 'LAPTOP-BACKUP',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# FAT32 refuses any single file of 4 GB or more. Skips are counted and named rather than
# swallowed - a backup that silently omits the one irreplaceable file is worse than none.
$FAT32_MAX_FILE_BYTES = 4GB

# Never fill the stick to the last byte. FAT32 has no journal, and a full volume is where
# directory corruption happens - on a machine that hard-freezes twice a month that is not
# a theoretical concern.
$HEADROOM_BYTES = 500MB

function Write-Head { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

# --------------------------------------------------------------------------------------
# What gets copied, ORDERED BY HOW IRREPLACEABLE IT IS, because the stick is too small
# for all of it. 'Filter' limits a source to those extensions: the phone folder is split
# by type rather than copied whole so that 3.6 GB of re-downloadable .exe installers
# cannot crowd out irreplaceable photographs.
#
# The repo is deliberately absent: ai-trading-dashboard is in git, pushed to the remote,
# AND pulled onto the VPS, so it already has three copies. This is for what has one.
# --------------------------------------------------------------------------------------
$Sources = @(
    # --- irreplaceable and tiny: first, they cost almost nothing ----------------------
    [pscustomobject]@{ Name = 'Brain-vault';       Path = 'C:\Users\User\Documents\Brain' }
    [pscustomobject]@{ Name = 'Claude-memory';     Path = 'C:\Users\User\.claude\projects\C--Users-User-ai-trading-dashboard\memory' }
    [pscustomobject]@{ Name = 'ml_trading_system'; Path = Join-Path $env:USERPROFILE 'ml_trading_system' }
    [pscustomobject]@{ Name = 'MT5-config';        Path = "$env:APPDATA\MetaQuotes\Terminal"
                       Filter = @('*.set','*.tpl','*.ini','*.mq5','*.mq4','*.ex5','*.ex4','*.chr') }

    # --- the user's own working files -------------------------------------------------
    [pscustomobject]@{ Name = 'Desktop';           Path = Join-Path $env:USERPROFILE 'Desktop' }
    [pscustomobject]@{ Name = 'Documents';         Path = Join-Path $env:USERPROFILE 'Documents' }
    [pscustomobject]@{ Name = 'Pictures';          Path = Join-Path $env:USERPROFILE 'Pictures' }
    [pscustomobject]@{ Name = 'Videos';            Path = Join-Path $env:USERPROFILE 'Videos' }

    # --- the phone. 5,722 photographs with no other copy anywhere ---------------------
    [pscustomobject]@{ Name = 'Phone-Photos';      Path = "$env:USERPROFILE\CrossDevice"
                       Filter = @('*.jpg','*.jpeg','*.png','*.heic','*.gif','*.webp') }
    [pscustomobject]@{ Name = 'Phone-Documents';   Path = "$env:USERPROFILE\CrossDevice"
                       Filter = @('*.pdf','*.ipynb','*.npy','*.txt','*.docx','*.xlsx','*.csv','*.pptx') }
    [pscustomobject]@{ Name = 'Phone-Videos';      Path = "$env:USERPROFILE\CrossDevice"
                       Filter = @('*.mp4','*.mov','*.3gp','*.mkv') }

    # --- last, because it is all re-downloadable --------------------------------------
    [pscustomobject]@{ Name = 'Downloads';         Path = Join-Path $env:USERPROFILE 'Downloads' }
    [pscustomobject]@{ Name = 'Phone-Installers';  Path = "$env:USERPROFILE\CrossDevice"
                       Filter = @('*.exe','*.apk','*.zip','*.msi') }
)

# .ssh is ABSENT ON PURPOSE and must stay absent. It holds the private keys to the VPS,
# and this stick is unencrypted FAT32 that travels in a bag - anyone who picks it up
# would own the trading server. Protecting those keys needs encryption, not a copy.

# Returns the files a source actually contributes, honouring its extension filter.
function Get-SourceFiles {
    param($Source)
    if (-not (Test-Path $Source.Path)) { return @() }
    $files = Get-ChildItem $Source.Path -Recurse -File -Force -ErrorAction SilentlyContinue
    if ($Source.PSObject.Properties.Name -contains 'Filter' -and $Source.Filter) {
        $exts = $Source.Filter | ForEach-Object { $_.TrimStart('*').ToLower() }
        $files = $files | Where-Object { $e = $_.Extension.ToLower(); $exts -contains $e }
    }
    return @($files)
}

# --------------------------------------------------------------------------------------
# Find the stick by serial. Refuse rather than guess.
# --------------------------------------------------------------------------------------
Write-Head 'Locating the USB stick'
$volume = @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.VolumeSerialNumber -eq $VolumeSerial })

if ($volume.Count -eq 0) {
    Write-Host "USB stick with serial $VolumeSerial is not plugged in." -ForegroundColor Red
    Write-Host 'Nothing was copied and nothing was changed. Plug it in and run again.' -ForegroundColor Red
    exit 1
}
if ($volume.Count -gt 1) {
    Write-Host "More than one volume reports serial $VolumeSerial - refusing to guess." -ForegroundColor Red
    exit 1
}

$driveLetter = $volume[0].DeviceID
$freeBytes   = [int64]$volume[0].FreeSpace
Write-Host ("Found at {0}  ({1}, {2} GB free)" -f $driveLetter, $volume[0].FileSystem, [math]::Round($freeBytes / 1GB, 2)) -ForegroundColor Green

$destRoot = Join-Path "$driveLetter\" $BackupFolderName

# --------------------------------------------------------------------------------------
# Measure everything first, so the shortfall is known before a single byte moves.
# --------------------------------------------------------------------------------------
Write-Head 'Measuring'
$plan = @()
$grandBytes = 0
$grandFiles = 0

foreach ($src in $Sources) {
    if (-not (Test-Path $src.Path)) {
        Write-Host ("  {0,-18} MISSING - skipped, and said so" -f $src.Name) -ForegroundColor Yellow
        continue
    }
    $files    = Get-SourceFiles $src
    $oversize = @($files | Where-Object { $_.Length -ge $FAT32_MAX_FILE_BYTES })
    $usable   = @($files | Where-Object { $_.Length -lt $FAT32_MAX_FILE_BYTES })
    $bytes    = ($usable | Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { $bytes = 0 }

    $plan += [pscustomobject]@{
        Name = $src.Name; Source = $src; Files = $usable.Count
        Bytes = [int64]$bytes; Oversize = $oversize; Status = 'pending'
    }
    $grandBytes += $bytes
    $grandFiles += $usable.Count
    Write-Host ("  {0,-18} {1,6} files  {2,9} MB" -f $src.Name, $usable.Count, [math]::Round($bytes / 1MB))
}

Write-Host ("  {0,-18} {1,6} files  {2,9} MB" -f 'TOTAL WANTED', $grandFiles, [math]::Round($grandBytes / 1MB)) -ForegroundColor Cyan
Write-Host ("  {0,-18} {1,15} MB" -f 'SPACE AVAILABLE', [math]::Round(($freeBytes - $HEADROOM_BYTES) / 1MB)) -ForegroundColor Cyan

if ($grandBytes -gt ($freeBytes - $HEADROOM_BYTES)) {
    $shortMB = [math]::Round(($grandBytes - ($freeBytes - $HEADROOM_BYTES)) / 1MB)
    Write-Host "`n  IT DOES NOT ALL FIT - short by $shortMB MB." -ForegroundColor Yellow
    Write-Host '  Sources are taken in the order above (most irreplaceable first).' -ForegroundColor Yellow
    Write-Host '  Whatever does not fit is named below AND in NOT-BACKED-UP.txt on the stick.' -ForegroundColor Yellow
}

if ($DryRun) {
    Write-Head 'DRY RUN'
    Write-Host 'Nothing written.' -ForegroundColor Yellow
    exit 0
}

# --------------------------------------------------------------------------------------
# Copy, in priority order, checking the space actually left before each source.
# /E all subfolders, /XO never overwrite a NEWER file on the stick with an older one,
# /FFT for FAT's 2-second timestamps, /XJ so a junction cannot send robocopy in a loop.
# No /MIR. No /PURGE.
# --------------------------------------------------------------------------------------
Write-Head 'Copying'
$logFile = Join-Path $PSScriptRoot 'logs\usb_mirror.txt'
$logDir  = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$remaining = $freeBytes - $HEADROOM_BYTES

foreach ($item in $plan) {
    if ($item.Bytes -gt $remaining) {
        $item.Status = 'NO ROOM'
        Write-Host ("  {0,-18} SKIPPED - needs {1} MB, {2} MB left" -f `
            $item.Name, [math]::Round($item.Bytes / 1MB), [math]::Round($remaining / 1MB)) -ForegroundColor Yellow
        continue
    }

    $dest = Join-Path $destRoot $item.Name
    $args = @($item.Source.Path, $dest)
    if ($item.Source.PSObject.Properties.Name -contains 'Filter' -and $item.Source.Filter) {
        $args += $item.Source.Filter
    }
    $args += @('/E','/XO','/FFT','/DST','/XJ','/R:1','/W:5','/NP','/NDL','/NFL',"/LOG+:$logFile")

    robocopy @args | Out-Null
    $code = $LASTEXITCODE

    # robocopy's exit code is a BITMASK, not an error number. 0-7 means it worked
    # (1=copied, 2=extra files on the destination - normal and desired here, because we
    # never delete). 8 and above means at least one file genuinely failed. Treating
    # "non-zero" as failure would report every healthy run as broken.
    if ($code -lt 8) {
        $item.Status = 'copied'
        $remaining -= $item.Bytes
        Write-Host ("  {0,-18} rc={1} ok    ({2} MB left)" -f $item.Name, $code, [math]::Round($remaining / 1MB)) -ForegroundColor Green
    } else {
        $item.Status = "FAILED rc=$code"
        Write-Host ("  {0,-18} rc={1} FAILED" -f $item.Name, $code) -ForegroundColor Red
    }
}

# --------------------------------------------------------------------------------------
# VERIFY BY COUNTING. This is the step the VPS backup did not have.
# --------------------------------------------------------------------------------------
Write-Head 'Verifying - counting files at source and on the stick'
$allGood = $true

foreach ($item in $plan) {
    if ($item.Status -ne 'copied') { continue }
    $dest = Join-Path $destRoot $item.Name
    $dstCount = if (Test-Path $dest) {
        (Get-ChildItem $dest -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count
    } else { 0 }

    # The stick may legitimately hold MORE than the source - files deleted on the laptop
    # are kept here on purpose. Fewer is the only thing that means something went wrong.
    if ($dstCount -lt $item.Files) {
        $allGood = $false
        Write-Host ("  {0,-18} SHORT: {1} on the stick vs {2} at the source" -f $item.Name, $dstCount, $item.Files) -ForegroundColor Red
    } else {
        $extra = $dstCount - $item.Files
        $note  = if ($extra -gt 0) { " (+$extra kept from earlier runs)" } else { '' }
        Write-Host ("  {0,-18} {1} files{2}" -f $item.Name, $dstCount, $note) -ForegroundColor Green
    }
}

# --------------------------------------------------------------------------------------
# Write down what is NOT protected, on the stick itself, so it cannot be forgotten.
# --------------------------------------------------------------------------------------
$notDone  = @($plan | Where-Object { $_.Status -ne 'copied' })
$oversize = @($plan | ForEach-Object { $_.Oversize } | Where-Object { $_ })

if ($notDone.Count -gt 0 -or $oversize.Count -gt 0) {
    $manifest = Join-Path $destRoot 'NOT-BACKED-UP.txt'
    $lines = @(
        "NOT BACKED UP - written $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
        "This stick is $([math]::Round($volume[0].Size / 1GB, 1)) GB and could not hold everything.",
        ''
    )
    foreach ($n in $notDone) {
        $lines += ("{0} : {1} file(s), {2} MB - {3}" -f $n.Name, $n.Files, [math]::Round($n.Bytes / 1MB), $n.Status)
    }
    if ($oversize.Count -gt 0) {
        $lines += ''
        $lines += "Files at or above the FAT32 4 GB limit (cannot go on this filesystem):"
        foreach ($f in $oversize) { $lines += ("  {0} ({1} GB)" -f $f.FullName, [math]::Round($f.Length / 1GB, 2)) }
    }
    $lines | Set-Content -Path $manifest -Encoding UTF8
    Write-Host "`nWrote $manifest" -ForegroundColor Yellow
}

Write-Head 'Result'
$copied = @($plan | Where-Object { $_.Status -eq 'copied' })
Write-Host ("Copied {0} of {1} sources into {2}" -f $copied.Count, $plan.Count, $destRoot)
if ($allGood -and $notDone.Count -eq 0 -and $oversize.Count -eq 0) {
    Write-Host 'EVERYTHING requested is on the stick. Plain files, no unpacking.' -ForegroundColor Green
} else {
    Write-Host 'NOT everything fits on this stick. What is missing:' -ForegroundColor Yellow
    foreach ($n in $notDone) {
        Write-Host ("  {0,-18} {1,6} files {2,8} MB  ({3})" -f $n.Name, $n.Files, [math]::Round($n.Bytes / 1MB), $n.Status) -ForegroundColor Yellow
    }
    $needGB = [math]::Round((($notDone | Measure-Object -Property Bytes -Sum).Sum) / 1GB, 1)
    if ($needGB -gt 0) { Write-Host "  A drive with $needGB GB more free space would hold the rest." -ForegroundColor Yellow }
}
Write-Host "Log: $logFile"
