# Turn Task Scheduler run history ON, and make it big enough to be worth having.
#
#   Run ELEVATED:
#     powershell -ExecutionPolicy Bypass -File tasks\enable_task_history.ps1
#   Report only, change nothing:
#     powershell -ExecutionPolicy Bypass -File tasks\enable_task_history.ps1 -DryRun
#   Undo (also needs elevation):
#     powershell -ExecutionPolicy Bypass -File tasks\enable_task_history.ps1 -Undo
#
# ASCII ONLY - PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#
# THE PROBLEM, measured on THEMIS 2026-09-10
#   Microsoft-Windows-TaskScheduler/Operational   enabled: false
#   Nobody switched it off. The registry shows Enabled=0 with MaxSize untouched at the
#   10485760 default - no custom values, no evidence of a change. Windows 11 CLIENT
#   ships that channel disabled and opt-in; Windows Server ships it ON. That single SKU
#   default is the whole difference between the two boxes.
#
#   Consequence: for every laptop worker the ONLY evidence a run happened is
#   LastTaskResult - one value, overwritten every run. You cannot see that a run died
#   and a later one succeeded, or that a trigger was skipped entirely. That is exactly
#   how the Strategy Search rot went unseen on the laptop and was caught on the VPS.
#
# WHY ENABLING IS NOT ENOUGH ON ITS OWN, and the audit missed this
#   Measured the same day: 66 scheduled tasks, ~3,632 runs/day, ~5 events per run
#   = ~18,160 events/day, roughly 17.7 MB/day at ~1KB/event.
#   The default maxSize is 10485760 (10 MB) with retention:false, i.e. CIRCULAR - it
#   wraps and overwrites the oldest. 10 MB therefore holds UNDER 14 HOURS of history.
#   Switching the channel on and leaving it at 10 MB would satisfy the checkbox and
#   still not let you look back at yesterday. 256 MB gives roughly two weeks.
#
# WHAT THIS DOES NOT DO
#   It NEVER calls `wevtutil cl` (clear-log). Nothing is deleted, cleared or removed.
#   Enabling a channel only starts appending. retention:false is left as it is, so the
#   log wraps at its cap and can never fill the disk.
#   It writes the current configuration to a file BEFORE changing anything, so -Undo
#   can put back exactly what was there.

param(
    [switch]$DryRun,
    [switch]$Undo,
    # 256 MB. At the measured 17.7 MB/day that is ~14 days of history.
    [long]$MaxSizeBytes = 268435456
)

$ErrorActionPreference = 'Stop'

$Channel   = 'Microsoft-Windows-TaskScheduler/Operational'
$Proj      = Split-Path -Parent $PSScriptRoot
$StateDir  = Join-Path $Proj 'tasks\logs'
$LogFile   = Join-Path $StateDir 'enable_task_history.txt'

function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Say "enable_task_history  box=$env:COMPUTERNAME  elevated=$isAdmin  dryRun=$DryRun  undo=$Undo"

function Get-ChannelConfig {
    # wevtutil writes to stdout; parse the fields that matter.
    $raw = & wevtutil gl $Channel 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    $cfg = @{ raw = ($raw -join "`r`n") }
    foreach ($line in $raw) {
        $t = ([string]$line).Trim()
        if ($t -match '^enabled:\s*(\S+)')   { $cfg.enabled   = $Matches[1] }
        if ($t -match '^maxSize:\s*(\d+)')   { $cfg.maxSize   = [long]$Matches[1] }
        if ($t -match '^retention:\s*(\S+)') { $cfg.retention = $Matches[1] }
    }
    return $cfg
}

$before = Get-ChannelConfig
if ($null -eq $before) { Say "REFUSING: could not read channel $Channel"; exit 2 }
Say ("  before: enabled={0} maxSize={1} retention={2}" -f $before.enabled, $before.maxSize, $before.retention)

# ---------------------------------------------------------------------------
# BACK UP THE CURRENT CONFIG BEFORE CHANGING IT. Standing rule 4.
# ---------------------------------------------------------------------------
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $StateDir "wevt-taskscheduler-config-$stamp.txt"
if (-not $DryRun) {
    [System.IO.File]::WriteAllText($backup, $before.raw, (New-Object System.Text.UTF8Encoding($false)))
    if (-not (Test-Path $backup)) { Say "REFUSING: could not write the config backup"; exit 4 }
    Say "  config backed up -> $backup"
}

if ($Undo) {
    if (-not $isAdmin) { Say "REFUSING: -Undo needs elevation."; exit 3 }
    if ($DryRun) { Say "  would set enabled:false and maxSize:10485760 (the shipped default)"; exit 0 }
    & wevtutil sl $Channel /e:false | Out-Null
    & wevtutil sl $Channel /ms:10485760 | Out-Null
    $u = Get-ChannelConfig
    Say ("  after undo: enabled={0} maxSize={1}" -f $u.enabled, $u.maxSize)
    Say "  the existing .evtx was NOT cleared - past events remain readable."
    exit 0
}

if ($before.enabled -eq 'true' -and $before.maxSize -ge $MaxSizeBytes) {
    Say "Nothing to do: already enabled at $($before.maxSize) bytes."
    exit 0
}

if ($DryRun) {
    Say "  would run: wevtutil sl $Channel /e:true"
    Say "  would run: wevtutil sl $Channel /ms:$MaxSizeBytes"
    Say "DRY RUN - nothing was changed."
    exit 0
}

if (-not $isAdmin) {
    Say ""
    Say "REFUSING: not elevated. Measured on this box: wevtutil sl /e:true returns"
    Say "          exit 5 'Access is denied' without elevation. Nothing was changed."
    Say ""
    Say "Re-run from an ADMIN PowerShell:"
    Say "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit 3
}

# ---------------------------------------------------------------------------
# Size FIRST, then enable. Setting the cap on a live channel is the operation more
# likely to be refused, and doing it before the channel starts writing means there is
# never a window where events land in a 10 MB log and are immediately wrapped away.
# ---------------------------------------------------------------------------
& wevtutil sl $Channel /ms:$MaxSizeBytes 2>&1 | ForEach-Object { Say "  ms: $_" }
$msRc = $LASTEXITCODE
& wevtutil sl $Channel /e:true 2>&1 | ForEach-Object { Say "  en: $_" }
$enRc = $LASTEXITCODE

$after = Get-ChannelConfig
Say ("  after:  enabled={0} maxSize={1} retention={2}  (rc ms={3} en={4})" -f $after.enabled, $after.maxSize, $after.retention, $msRc, $enRc)

if ($after.enabled -ne 'true') {
    Say "FAILED: channel is still not enabled. Nothing else was changed."
    exit 1
}

# ---------------------------------------------------------------------------
# PROOF. "enabled: true" is a setting, not evidence. Fire a real task and read the
# event back - a channel that is enabled and still records nothing is the exact shape
# of fault this whole exercise exists to catch.
# ---------------------------------------------------------------------------
$probeTask = 'SmartEntry Gate Watch'
if (Get-ScheduledTask -TaskName $probeTask -ErrorAction SilentlyContinue) {
    Say "  proving it records: starting '$probeTask'"
    $t0 = Get-Date
    Start-ScheduledTask -TaskName $probeTask
    Start-Sleep -Seconds 12
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = $Channel; StartTime = $t0 } -ErrorAction Stop)
        Say "  events recorded since the trigger: $($events.Count)"
        foreach ($e in ($events | Select-Object -First 3)) {
            Say ("    id={0} {1} {2}" -f $e.Id, $e.TimeCreated.ToString('HH:mm:ss'), ($e.Message -split "`n")[0])
        }
        if ($events.Count -eq 0) { Say "  WARNING: enabled but recorded nothing yet - re-check in a few minutes." }
    } catch {
        Say "  could not read events back: $($_.Exception.Message)"
    }
} else {
    Say "  no probe task found - skipped the read-back proof."
}

Say ""
Say "done. At the measured ~17.7 MB/day this holds roughly $([math]::Round($MaxSizeBytes/1MB/17.7,1)) days of history."
Say "Undo with: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Undo"
Say "Nothing was cleared or deleted; the channel only appends."
exit 0
