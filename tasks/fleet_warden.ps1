# Fleet Warden - run the parity check on a schedule instead of only when someone looks.
#
#   powershell -File tasks\fleet_warden.ps1
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM, so an em dash in this
# file arrives mangled and a string comparison silently fails.
#
# WHY THIS EXISTS. tasks\vps_parity.cjs is the only thing that can see the two boxes
# diverge, and nothing ever ran it. It fired when a human remembered - which is how 23
# capability files, including seven skills and eight analysis harnesses, came to be
# missing from the box that trades with nobody noticing. A check that only runs when you
# already suspect a problem is not a check; it is a confirmation.
#
# IT CHANGES NOTHING. vps_parity.cjs is read-only over both boxes: it hashes files and
# compares, and it cannot write to either. This wrapper adds a log and an exit code. No
# file is synced, no setting touched, no trade affected.
#
# THE EXIT CODE IS DELIBERATELY NOT THE DRIFT COUNT. Some absences are load-bearing -
# tasks\bridge_tags.ps1 MUST stay laptop-only, because the VPS carries that function
# inline and the missing file is what stops a wholesale ensure_running.ps1 copy starting
# a second bridge on a one-account box. A red that fires on a correct state trains you to
# skim past it. Exit 2 is reserved for ENGINE drift, which is never deliberate.

$ErrorActionPreference = 'Continue'

$proj = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $PSScriptRoot 'logs\fleet_warden.txt'
$dir  = Split-Path -Parent $log
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

function Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Host $line
}

Log '--- fleet warden start ---'

$parity = Join-Path $PSScriptRoot 'vps_parity.cjs'
if (-not (Test-Path $parity)) {
    Log 'REFUSED: tasks\vps_parity.cjs not found'
    exit 1
}

# --emit so the JSON artifact is refreshed for /api/system-plan and the dashboards; they
# read that file, so a warden that printed to a log nobody opens would be the same
# failure it exists to catch.
$out = & node $parity --emit 2>&1 | Out-String
$rc  = $LASTEXITCODE

Add-Content -Path $log -Value $out -Encoding UTF8

# Pull the headline numbers back out of the report rather than recomputing them, so this
# wrapper can never disagree with the tool it is reporting on.
$engines  = if ($out -match 'ENGINES AGREE') { 'AGREE' } elseif ($out -match 'ENGINES DIVERGE') { 'DIVERGE' } else { 'UNKNOWN' }
$absent   = if ($out -match 'ABSENT ON THE VPS \((\d+)\)')        { [int]$Matches[1] } else { 0 }
$differ   = if ($out -match 'CONTENT DIFFERS \((\d+)\)')          { [int]$Matches[1] } else { 0 }
$tracked  = if ($out -match '(\d+) tracked file\(s\) differ')     { [int]$Matches[1] } else { 0 }

Log ("engines={0} trackedDrift={1} absentOnVps={2} contentDiffers={3} parityExit={4}" -f `
     $engines, $tracked, $absent, $differ, $rc)

if ($engines -eq 'DIVERGE' -or $rc -eq 2) {
    Log 'ENGINE DRIFT - the two boxes can admit different trades from identical bars.'
    Log 'Numbers that pool both journals are unattributable until this is reconciled.'
    Log '--- fleet warden done (exit 2) ---'
    exit 2
}

if ($absent -or $differ) {
    Log 'Drift present and NOT failing the run: some absences are deliberate. Read the'
    Log 'list above and judge direction per file - never sync blindly.'
}

Log '--- fleet warden done (exit 0) ---'
exit 0
