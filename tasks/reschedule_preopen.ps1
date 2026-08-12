# Move tomorrow's pre-open plan out of a news blackout.
#
#   powershell -File tasks\reschedule_preopen.ps1 [-WhatIf]
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY THIS EXISTS
# The pre-open plan was first scheduled at a fixed 12:00 UTC, one hour before the NEW
# YORK open. On its very first day the calendar put Core PPI and PPI at 12:30, whose
# blackout window closes 12:00-13:00 - so the job would have fired into the exact hour
# it was built to prepare for, and the plan would have opened by announcing that the
# hour it covers is shut.
#
# tasks\deep_plan.cjs computes the slot: it walks BACKWARD from 60 minutes before the
# open in 15-minute steps until it finds a moment outside every blackout, floored at 3
# hours before the open. This script reads that answer and moves the trigger.
#
# FAILURE MODE IS DELIBERATE. If anything here fails - no artifact, unparseable JSON,
# no such task - it leaves the EXISTING trigger untouched and exits non-zero. The job
# then still runs at yesterday's time, which is late or early but never missing. A
# rescheduler whose failure mode is "no run at all" would be worse than the fixed time
# it replaced.

param([switch]$WhatIf)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$taskName = 'SmartEntry Pre-Open Plan'
$planFile = Join-Path $proj 'tasks\analysis\deep-plan-latest.json'
$log = Join-Path $proj 'tasks\logs\reschedule_preopen.txt'

function Say($msg) {
    $line = "[" + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + "] $msg"
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding utf8
}

if (-not (Test-Path $planFile)) {
    Say "NO CHANGE: $planFile not found - leaving the existing trigger alone."
    exit 1
}

try {
    $plan = Get-Content $planFile -Raw | ConvertFrom-Json
} catch {
    Say ("NO CHANGE: could not parse the plan artifact - " + $_.Exception.Message)
    exit 1
}

$slot = $plan.preOpenSlot
if (-not $slot -or -not $slot.at) {
    Say "NO CHANGE: the plan carries no preOpenSlot."
    exit 1
}

# The artifact stores UTC. Scheduled tasks fire on LOCAL time and the two boxes sit in
# different timezones, so the conversion is done from the instant rather than by
# assuming an offset - the laptop is London and the VPS is Berlin.
$slotUtc = [DateTime]::Parse($slot.at, [Globalization.CultureInfo]::InvariantCulture,
                             [Globalization.DateTimeStyles]::RoundtripKind)
$slotLocal = $slotUtc.ToLocalTime()

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Say "NO CHANGE: scheduled task '$taskName' does not exist - run tasks\install_market_schedule.ps1 first."
    exit 1
}

$currentAt = $null
foreach ($t in $existing.Triggers) { if ($t.StartBoundary) { $currentAt = ([DateTime]::Parse($t.StartBoundary)).ToString('HH:mm') } }
$targetAt = $slotLocal.ToString('HH:mm')

if ($currentAt -eq $targetAt) {
    Say ("no move needed: already at {0} local ({1} UTC) - {2}" -f $targetAt, $slotUtc.ToString('HH:mm'), $slot.reason)
    exit 0
}

if ($WhatIf) {
    Say ("WHATIF: would move '{0}' from {1} to {2} local ({3} UTC) - {4}" -f `
        $taskName, $currentAt, $targetAt, $slotUtc.ToString('HH:mm'), $slot.reason)
    exit 0
}

try {
    # Replace the trigger only. Rebuilding the whole task would discard the settings that
    # make it survive a sleeping laptop.
    $trigger = New-ScheduledTaskTrigger -Daily -At $slotLocal
    Set-ScheduledTask -TaskName $taskName -Trigger $trigger | Out-Null
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Say ("moved '{0}' {1} -> {2} local ({3} UTC). Next run {4}. Reason: {5}" -f `
        $taskName, $currentAt, $targetAt, $slotUtc.ToString('HH:mm'), $info.NextRunTime, $slot.reason)
    if (-not $slot.confident) {
        Say "  NOTE: that slot was NOT chosen from a clean calendar read - timing is provisional."
    }
    exit 0
} catch {
    Say ("NO CHANGE: could not set the trigger - " + $_.Exception.Message)
    exit 1
}
