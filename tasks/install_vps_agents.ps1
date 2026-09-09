# =============================================================================
#  install_vps_agents.ps1  --  register the five agent jobs on the VPS
# =============================================================================
#  WHY. Until 2026-09-09 the VPS carried all seven agent DEFINITIONS in
#  .claude\agents\ and not one scheduled task to invoke any of them. Every agent
#  job -- analyst, code-reviewer, medic, researcher, tester -- existed only on
#  the laptop, which was asleep 58.7% of the last ~112 days. The reviewing and
#  diagnosing ran on the machine that is usually off, for the machine that
#  trades continuously.
#
#  SETTINGS ARE COPIED FROM SmartEntryMorningAgent, NOT INVENTED. That task is
#  the one agent-shaped job already proven to work on this box (64.3KB of real
#  output on 2026-09-09 at 07:04). Principal Administrator / RunLevel Highest /
#  LogonType Interactive / ExecutionTimeLimit PT72H / StartWhenAvailable /
#  MultipleInstances IgnoreNew are all taken from it verbatim.
#
#  PT72H IS DELIBERATE. A subscription ceiling parks the brief rather than
#  failing it, and SmartEntryAgentDrain resumes it later; a short limit would
#  kill a parked run mid-resume.
#
#  TIMES ARE STAGGERED AGAINST THE LAPTOP ON PURPOSE. Both boxes draw on ONE
#  Claude subscription. The laptop runs tester 05:30, medic 11:00,
#  code-reviewer 16:00 at UTC+1; the VPS is UTC+2, so the offsets below leave
#  roughly two hours of real time between the same agent on the two machines.
#
#  IDEMPOTENT AND NON-DESTRUCTIVE. An existing task of the same name is
#  REPORTED AND SKIPPED, never overwritten and never unregistered -- nothing
#  here deletes. Re-running it is safe.
# =============================================================================

$ErrorActionPreference = 'Stop'

$ROOT   = 'C:\ai-trading-dashboard'
$RUNNER = Join-Path $ROOT 'tasks\run_agent.bat'

# agent name -> task name, schedule kind, time, (weekday for weekly)
$JOBS = @(
    @{ agent = 'tester';        task = 'SmartEntry Agent Tester';       kind = 'Daily';  at = '06:30' }
    @{ agent = 'medic';         task = 'SmartEntry Agent Medic';        kind = 'Daily';  at = '12:00' }
    @{ agent = 'code-reviewer'; task = 'SmartEntry Agent CodeReviewer'; kind = 'Daily';  at = '17:00' }
    @{ agent = 'analyst';       task = 'SmartEntry Agent Analyst';      kind = 'Weekly'; at = '21:00'; day = 'Sunday' }
    @{ agent = 'researcher';    task = 'SmartEntry Agent Researcher';   kind = 'Weekly'; at = '23:30'; day = 'Sunday' }
)

if (-not (Test-Path $RUNNER)) {
    Write-Output "ABORT: runner missing at $RUNNER"
    exit 2
}
Write-Output "runner  : $RUNNER  ($((Get-Item $RUNNER).Length) bytes)"

# Every definition must exist before anything is registered, so a typo cannot
# leave a task pointing at a brief that is not there.
foreach ($j in $JOBS) {
    $def = Join-Path $ROOT ".claude\agents\$($j.agent).md"
    if (-not (Test-Path $def)) {
        Write-Output "ABORT: no definition for '$($j.agent)' at $def"
        exit 2
    }
}
Write-Output "defs    : all 5 present"
Write-Output ''

$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                -ExecutionTimeLimit ([TimeSpan]::FromHours(72)) `
                -MultipleInstances IgnoreNew `
                -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$made = 0; $skipped = 0
foreach ($j in $JOBS) {
    $existing = Get-ScheduledTask -TaskName $j.task -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Output ("SKIP    : {0} already exists (state {1}) -- left untouched" -f $j.task, $existing.State)
        $skipped++
        continue
    }

    $action = New-ScheduledTaskAction -Execute 'cmd.exe' `
                -Argument ('/c "{0}" {1}' -f $RUNNER, $j.agent)

    if ($j.kind -eq 'Weekly') {
        $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $j.day -At $j.at
    } else {
        $trigger = New-ScheduledTaskTrigger -Daily -At $j.at
    }

    Register-ScheduledTask -TaskName $j.task -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description ("SmartEntry '{0}' agent. Report only -- run_agent.bat forbids edits, commits, task changes and trades." -f $j.agent) | Out-Null

    $info = Get-ScheduledTask -TaskName $j.task | Get-ScheduledTaskInfo
    Write-Output ("CREATED : {0,-34} {1,-6} {2}  next {3}" -f $j.task, $j.kind, $j.at, $info.NextRunTime)
    $made++
}

Write-Output ''
Write-Output "created $made, skipped $skipped"
