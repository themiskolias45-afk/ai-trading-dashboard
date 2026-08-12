# Register the two market-hour jobs: post-close analysis, and the pre-open plan.
#
#   powershell -File tasks\install_market_schedule.ps1
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY THESE TIMES
# Every other scheduled job on this fleet is clock-scheduled with no relation to the
# market: the morning agent at 05:00 UTC and the daily check at 05:30, both inside the
# ASIAN session, which is the ONLY session measured negative at the live gate
# (-0.116R/trade over 96 trades). Nothing ran after the close and nothing ran before
# the NEW YORK open, the only session measured positive (+0.255R/trade over 84).
#
#   POST-CLOSE  21:30 UTC  after the 21:00 daily close, before the 22:00 Asian open.
#               Regenerates the walk-forward and heat-map artifacts. ~7 minutes.
#   PRE-OPEN    12:00 UTC  exactly one hour before the NEW YORK open at 13:00.
#               Reads those fresh artifacts and prints the plan. Seconds.
#
# THE BOXES ARE IN DIFFERENT TIMEZONES and scheduled tasks fire on LOCAL time, so a
# single hardcoded clock reading would run these an hour apart on the two machines.
# The offset is read from the machine, never assumed. Laptop is London (UTC+1 in
# summer), VPS is Berlin (UTC+2).

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot

function UtcHourToLocal([int]$utcHour, [int]$utcMinute) {
    # Anchor on a real instant so DST is resolved by the OS rather than by arithmetic.
    # Using "now" as the date is deliberate: the task recurs daily and Windows shifts a
    # daily trigger with the local clock, so the offset only needs to be right today.
    $utcNow = (Get-Date).ToUniversalTime()
    $target = [DateTime]::SpecifyKind(
        (Get-Date -Year $utcNow.Year -Month $utcNow.Month -Day $utcNow.Day `
                  -Hour $utcHour -Minute $utcMinute -Second 0), [DateTimeKind]::Utc)
    return $target.ToLocalTime()
}

function Register-MarketTask {
    param([string]$Name, [string]$Script, [int]$UtcHour, [int]$UtcMinute, [string]$Why)

    $scriptPath = Join-Path $proj $Script
    if (-not (Test-Path $scriptPath)) {
        Write-Host ("  SKIP  {0} - {1} not found" -f $Name, $Script) -ForegroundColor Yellow
        return
    }

    $local = UtcHourToLocal $UtcHour $UtcMinute
    $localText = $local.ToString('HH:mm')

    if ($scriptPath -like '*.ps1') {
        $exe = 'powershell.exe'
        $arg = ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $scriptPath)
    } else {
        $exe = 'node.exe'
        $arg = ('"{0}"' -f $scriptPath)
    }

    $action  = New-ScheduledTaskAction -Execute $exe -Argument $arg -WorkingDirectory $proj
    $trigger = New-ScheduledTaskTrigger -Daily -At $local

    # StartWhenAvailable so a laptop that was asleep at the trigger still runs the job
    # when it wakes; without it the run is simply skipped and the morning silently reads
    # stale artifacts. DontStopIfGoingOnBatteries because the default REFUSES to start
    # on battery, which is how the autostart task came to never fire on lid-open.
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Settings $settings -Description $Why -Force | Out-Null

    Write-Host ("  OK    {0}" -f $Name) -ForegroundColor Green
    Write-Host ("        {0:D2}:{1:D2} UTC = {2} local, daily" -f $UtcHour, $UtcMinute, $localText)
}

Write-Host "Registering market-hour jobs..." -ForegroundColor Cyan

Register-MarketTask -Name 'SmartEntry Post-Close Analysis' `
    -Script 'tasks\postclose_analysis.ps1' -UtcHour 21 -UtcMinute 30 `
    -Why 'Regenerates walk-forward and heat-map evidence after the daily close.'

Register-MarketTask -Name 'SmartEntry Pre-Open Plan' `
    -Script 'tasks\preopen_plan.cjs' -UtcHour 12 -UtcMinute 0 `
    -Why 'Deterministic entry plan one hour before the NEW YORK open.'

Write-Host ""
Write-Host "Verifying:" -ForegroundColor Cyan
Get-ScheduledTask | Where-Object { $_.TaskName -like 'SmartEntry P*' } |
    ForEach-Object {
        $info = Get-ScheduledTaskInfo -TaskName $_.TaskName
        Write-Host ("  {0,-34} {1,-9} next {2}" -f $_.TaskName, $_.State, $info.NextRunTime)
    }
