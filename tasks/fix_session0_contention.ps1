# Move two SYSTEM tasks off their collision windows, and let transient failures retry.
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY THIS EXISTS
# 'SmartEntry Doctor' and 'SmartEntry Plan Review' both returned 3221225794 on the VPS.
# That is 0xC0000142, STATUS_DLL_INIT_FAILED - a process that could not be CREATED, not a
# script that ran and failed. Both scripts are healthy: triggered on demand on 2026-09-05
# they returned 0, and doctor.cjs --selftest passes. They fail only at their scheduled
# time, and both scheduled times sit inside a burst of session-0 process creation:
#
#   Doctor 07:10      - Morning Agent starts 07:00 and is still spawning children, and
#                       the PT10M/PT15M SYSTEM monitors fire around the same minutes.
#   Plan Review 23:40 - Spread Probe repeats every 5 minutes from 23:00, so it fires at
#                       exactly 23:40, on top of Post-Close Analysis running since 23:30.
#
# Every other SYSTEM task on the box returns 0 (Bar Keeper, Plan Monitor, Backup,
# BandMonitor, EnsureRunning, Heartbeat, StrategySearch), so session 0 is not broken in
# general - which is what points at CONTENTION rather than configuration.
#
# WHAT THIS DOES AND DOES NOT DO
# It changes the START MINUTE of two tasks and adds a retry to three. It does not change
# what any task runs, its principal, its arguments, or any trading behaviour. Nothing is
# deleted and no task is disabled. The retry is strictly additive: a task that used to
# fail once and wait a day now gets two more attempts, so it can only ever produce MORE
# successful runs, never fewer.
#
# THE DEEPER FIX IS NOT DONE HERE, DELIBERATELY. The root cause is the noninteractive
# desktop heap (HKLM\...\SubSystems\Windows, third SharedSection value, default 768 KB).
# Raising it needs a REBOOT, and this box holds open positions and runs the bridge. A
# schedule change is reversible in seconds and needs no reboot; the registry change is
# the thing to do at the next planned restart, not on a live trading box.
#
#   powershell -File tasks\fix_session0_contention.ps1 [-WhatIf]
#
# TO UNDO: set the two triggers back to 07:10 and 23:40, and RestartCount back to 0.
# The script prints the exact before-values so the undo is copy-pasteable.

param([switch]$WhatIf)

$ErrorActionPreference = 'Stop'

# Minutes chosen to miss every repeating SYSTEM cadence on this box:
#   PT15M monitors fire at :01/:16/:31/:46 and :02/:17/:32/:47
#   EnsureRunning PT10M   fires at :03/:13/:23/:33/:43/:53
#   Bar Keeper PT1H       fires at :07
#   Spread Probe PT5M     fires at :00/:05/:10/.../:55 after 23:00
# :26 and :49 collide with none of them.
$moves = @(
    @{ Task = 'SmartEntry Doctor';      From = '07:10'; To = '06:26'
       Why  = 'off the 07:00 Morning Agent burst and the 07:15 Coverage Audit' },
    @{ Task = 'SmartEntry Plan Review'; From = '23:40'; To = '23:49'
       Why  = 'off the Spread Probe PT5M cadence, which hits :40 exactly' }
)

# A transient contention failure currently costs a whole day's run. Two retries at five
# minutes turns that into a delay instead of a miss.
$retries = @('SmartEntry Doctor', 'SmartEntry Plan Review', 'SmartEntry Pre-Open Reschedule')

Write-Host "=== BEFORE ==="
foreach ($m in $moves + @{Task='SmartEntry Pre-Open Reschedule'}) {
    $t = Get-ScheduledTask -TaskName $m.Task -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host ("  MISSING: " + $m.Task); continue }
    $i = $t | Get-ScheduledTaskInfo
    $at = ($t.Triggers | Where-Object { $_.StartBoundary } | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') }) -join ','
    Write-Host ("  {0,-32} at={1,-6} result={2,-12} restartCount={3}" -f $m.Task, $at, $i.LastTaskResult, $t.Settings.RestartCount)
}

if ($WhatIf) { Write-Host "`n-WhatIf: nothing changed."; exit 0 }

Write-Host "`n=== APPLYING ==="
foreach ($m in $moves) {
    $t = Get-ScheduledTask -TaskName $m.Task -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host ("  SKIP (missing): " + $m.Task); continue }

    # Rebuild the trigger at the new time. Daily is what these two already are; reading
    # the existing trigger and only moving its StartBoundary keeps every other property.
    $old = $t.Triggers | Where-Object { $_.StartBoundary } | Select-Object -First 1
    if (-not $old) { Write-Host ("  SKIP (no time trigger): " + $m.Task); continue }
    $when = [datetime]$old.StartBoundary
    $newAt = [datetime]::ParseExact($m.To, 'HH:mm', $null)
    $moved = Get-Date -Year $when.Year -Month $when.Month -Day $when.Day -Hour $newAt.Hour -Minute $newAt.Minute -Second 0

    $trigger = New-ScheduledTaskTrigger -Daily -At $moved
    Set-ScheduledTask -TaskName $m.Task -Trigger $trigger | Out-Null
    Write-Host ("  moved {0}: {1} -> {2}   ({3})" -f $m.Task, $m.From, $m.To, $m.Why)
}

foreach ($name in $retries) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host ("  SKIP (missing): " + $name); continue }
    $s = $t.Settings
    $s.RestartCount = 2
    $s.RestartInterval = 'PT5M'
    Set-ScheduledTask -TaskName $name -Settings $s | Out-Null
    Write-Host ("  retry on failure: {0} -> 2 attempts, 5 minutes apart" -f $name)
}

Write-Host "`n=== AFTER ==="
foreach ($name in (($moves | ForEach-Object { $_.Task }) + 'SmartEntry Pre-Open Reschedule')) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { continue }
    $i = $t | Get-ScheduledTaskInfo
    $at = ($t.Triggers | Where-Object { $_.StartBoundary } | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') }) -join ','
    Write-Host ("  {0,-32} at={1,-6} nextRun={2}  restartCount={3}" -f $name, $at, $i.NextRunTime, $t.Settings.RestartCount)
}
Write-Host "`nNothing was deleted, disabled, or changed in what any task runs."
