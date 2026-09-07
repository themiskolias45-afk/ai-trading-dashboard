# Registers the brain sync as its own scheduled task on the LAPTOP.
#
# WHY IT NEEDS ITS OWN TASK AND NOT JUST THE NIGHTLY. brain_sync was wired into
# auto_daily.bat, which runs at 07:30 LOCAL on each box. Measured 2026-09-02, that is not
# one time - it is two, an hour apart, because the boxes are in different timezones:
#
#   laptop  SmartEntry - Daily Check   07:30 +01:00  =  06:30Z
#   vps     SmartEntryDailyCheck       07:30 +02:00  =  05:30Z
#
# So the VPS's daily agent ran a full hour BEFORE the sync it depends on, and was briefed
# on the brain as it stood at the PREVIOUS sync - up to ~24h stale on memories written the
# day before. The sync has to land before the EARLIER of the two nightlies, not before the
# laptop's.
#
# AND THE LAPTOP IS NOT ON 24/7, which is the harder half. A single daily trigger it sleeps
# through is a day with no sync at all, and the VPS silently falls behind again. So this
# repeats every few hours with StartWhenAvailable, and any wake during the day catches up.
#
# 04:00 LOCAL, NOT 04:00Z, AND THE MARGIN IS DELIBERATE. 04:00 local is 03:00Z under BST
# and 04:00Z under GMT; the VPS nightly is 05:30Z under CEST and 06:30Z under CET. The
# sync therefore lands ahead of it in BOTH daylight-saving states without anyone having to
# remember to re-check in October. Setting it to a UTC-looking hour would have been the
# same class of bug this whole task exists to work around.
#
# RUNS FROM THE LAPTOP ONLY, and brain_sync.cjs enforces that itself: CLAUDE.md records
# that the laptop cannot be reached from outside, so the VPS could never initiate it. The
# script skips itself there rather than ssh-ing to its own address and "succeeding".
#
#   powershell -ExecutionPolicy Bypass -File tasks\install_brain_sync.ps1
#   powershell -ExecutionPolicy Bypass -File tasks\install_brain_sync.ps1 -Remove
#
# ASCII ONLY. PowerShell 5.1 reads a .ps1 as ANSI unless it carries a BOM, so a UTF-8
# em-dash becomes three bytes and can terminate a string mid-parse - four parse errors
# from four characters, measured 2026-09-02.

param(
    [switch]$Remove,
    [int]$RepeatHours = 4,
    [string]$AtLocal = '04:00'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'SmartEntry Brain Sync'
$root     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $root 'tasks\brain_sync.cjs'
$logFile  = Join-Path $root 'tasks\logs\brain_sync.txt'

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        "Removed '$TaskName'."
    } else { "No task named '$TaskName'." }
    return
}

# Refuse on the VPS rather than register a task that can only no-op there.
if ($root -notmatch '\\Users\\') {
    "REFUSING: this looks like the VPS ($root). The sync runs FROM the laptop only."
    return
}

if (-not (Test-Path $script)) { throw "brain_sync.cjs not found at $script" }

# Resolve node by RUNNING it, never by trusting PATH. A task that resolves to a different
# node than the shell does fails in a way nobody sees - and a BARE exe name in a scheduled
# task returned result 0 while writing nothing on the VPS, measured 2026-09-02.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not on PATH - the task would register and never run." }
& $node --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "node at $node did not execute" }

# The sync shells out to ssh and scp. If they are missing the task would register and fail
# every run with a message nobody reads, so it is checked here instead.
foreach ($bin in @('ssh', 'scp')) {
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        throw "$bin not on PATH - brain_sync cannot reach the VPS without it."
    }
}

$logDir = Split-Path -Parent $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# ASCII, not the default: PowerShell 5.1's *>> writes UTF-16LE with a BOM and every grep
# against the log then matches nothing, which reads as a task that never ran. Measured on
# eight task logs, 2026-09-02. Append, never overwrite - the sync history is the evidence
# that it is running.
$inner  = "& '$node' '$script' --apply 2>&1 | Out-File -FilePath '$logFile' -Append -Encoding ascii"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"') `
    -WorkingDirectory $root

# Daily at $AtLocal, then every $RepeatHours through the day. The repetition is what covers
# a laptop that was asleep at the daily time.
$trigger = New-ScheduledTaskTrigger -Daily -At $AtLocal
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours $RepeatHours) `
    -RepetitionDuration (New-TimeSpan -Hours 23)).Repetition

# A SECOND trigger on unlock. install_autostart.ps1 records that logon-only triggers never
# fire when a laptop lid is opened - the machine wakes and unlocks, it does not log on - so
# the lid-open case needs this explicitly or the first sync waits for the next repetition.
$cim = New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskSessionStateChangeTrigger `
        -Namespace Root/Microsoft/Windows/TaskScheduler) -ClientOnly
$cim.StateChange = 8          # TASK_SESSION_UNLOCK
$cim.Enabled     = $true

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew

# whoami, not $env:USERDOMAIN\$env:USERNAME: on the VPS those read WORKGROUP\administrator
# while the account is vmi3465345\administrator, and Register-ScheduledTask fails with
# HRESULT 0x80070534. Same call is used here so the two installers cannot drift.
$me = (& whoami).Trim()
if (-not $me) { throw "whoami returned nothing - cannot determine the principal" }
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
# THE UNLOCK TRIGGER IS BEST-EFFORT, NOT REQUIRED.
#
# Registering a session-state-change trigger needs elevation - measured here, it failed
# with HRESULT 0x80070005 "Access is denied" while the identical call WITHOUT it succeeds
# unelevated. Making it fatal would mean this task installs only from an admin shell, and
# a sync that is not installed is strictly worse than one that misses the lid-open case.
#
# The 4-hourly repetition plus StartWhenAvailable already covers a sleeping laptop: any
# wake gets a sync within the interval. The unlock trigger only makes that immediate.
$desc = "Union-syncs the laptop and VPS memory corpora. Never deletes; a file differing " +
        "on both boxes is reported and left alone. Runs at $AtLocal local and every " +
        "$RepeatHours h, because the laptop is not on 24/7 and the VPS nightly at 05:30Z " +
        "needs a fresh brain."
$withUnlock = $true
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger, $cim) `
        -Settings $settings -Principal $principal -Description ($desc + " Also on unlock.") | Out-Null
} catch {
    $withUnlock = $false
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description $desc | Out-Null
}

$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
"Registered '$TaskName' as $me."
"  daily at   : $AtLocal local, repeating every $RepeatHours h (StartWhenAvailable)"
if ($withUnlock) { "  unlock     : yes - also fires when the session is unlocked" }
else { "  unlock     : NOT registered (needs elevation). The $RepeatHours h repetition still covers a sleeping laptop; re-run this from an admin shell to add it." }
"  next run   : $($info.NextRunTime)"
"  script     : $script --apply"
"  log        : $logFile"
"  verify     : Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
