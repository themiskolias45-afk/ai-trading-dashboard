# ============================================================================
#  install_lab_drain.ps1 - register the Strategy Lab drain
# ============================================================================
#
#  Registers "SmartEntry Lab Drain", which runs tasks\lab_drain.ps1 on a repeat
#  so queued backtests execute out of band. The server never runs one; this does.
#
#  THREE DELIBERATE DIFFERENCES FROM install_autostart.ps1, all for safety:
#
#   1. DRY RUN BY DEFAULT. It prints exactly what it would register and changes
#      nothing until you pass -Execute. Same convention as
#      tasks\safe_server_restart.ps1, and for the same reason: a script that acts
#      the moment you run it gets run by accident exactly once.
#
#   2. IT NEVER DELETES A TASK. install_autostart.ps1 calls
#      Unregister-ScheduledTask to replace an existing one. This refuses instead,
#      and says so. With -Force it will replace - but only after EXPORTING the
#      existing definition to tasks\logs\<name>.<timestamp>.xml first, so the
#      thing it is about to overwrite still exists on disk afterwards. Nothing in
#      this project is destroyed to make room for something else.
#
#   3. IT ASSUMES NOTHING ABOUT ELEVATION. The task runs as the current user, at
#      Limited level, exactly like the drain does by hand. Reading CSVs and
#      writing JSON needs no more than that, and asking for more would be asking
#      for trouble.
#
#  WHAT THE TASK WILL DO, stated plainly: every $IntervalMinutes it runs
#  lab_drain.ps1, which executes at most -Max queued candidates against
#  historical CSV files and writes assessment artifacts. It does not contact the
#  broker, does not read or write any live config, and cannot change what trades.
#
#  USAGE
#    powershell -NoProfile -ExecutionPolicy Bypass -File tasks\install_lab_drain.ps1
#    powershell -NoProfile -ExecutionPolicy Bypass -File tasks\install_lab_drain.ps1 -Execute
#    powershell -NoProfile -ExecutionPolicy Bypass -File tasks\install_lab_drain.ps1 -Execute -Force
# ============================================================================

param(
    [switch]$Execute,
    [switch]$Force,
    [int]$IntervalMinutes = 15,
    [int]$Max = 50
)

$ErrorActionPreference = 'Stop'

$TaskName = 'SmartEntry Lab Drain'
$Proj     = Split-Path -Parent $PSScriptRoot
$Script   = Join-Path $Proj 'tasks\lab_drain.ps1'
$LogDir   = Join-Path $Proj 'tasks\logs'

# Wall-clock cap, independent of -Max. Two limits must both fail before a drain
# can occupy this machine for long.
$RunLimit = New-TimeSpan -Minutes 20
# 10 years, NOT [TimeSpan]::MaxValue. MaxValue serialises to P99999999DT23H59M59S,
# which Task Scheduler rejects outright with 0x80041318 - caught on the first
# -Execute here. install_autostart.ps1 already uses 3650 days for the same reason.
$Duration = New-TimeSpan -Days 3650

Write-Output ''
Write-Output ('  install_lab_drain  [{0}]' -f $(if ($Execute) { 'EXECUTE' } else { 'DRY RUN' }))
Write-Output ('  project   : {0}' -f $Proj)
Write-Output ('  task name : {0}' -f $TaskName)
Write-Output ('  runs      : powershell -File "{0}" -Max {1}' -f $Script, $Max)
Write-Output ('  every     : {0} minutes, indefinitely' -f $IntervalMinutes)
Write-Output ('  time limit: {0} minutes per run' -f $RunLimit.TotalMinutes)
Write-Output ('  log       : {0}' -f (Join-Path $LogDir 'lab_drain.txt'))
Write-Output ''

if (-not (Test-Path $Script)) {
    Write-Output ('  ABORT: {0} does not exist.' -f $Script)
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Output '  ABORT: node is not on PATH for this user, so the task would fail every tick.'
    exit 1
}

# Prove the drain actually runs BEFORE scheduling it. Registering a task that has
# never been executed once is how a job ends up failing silently for weeks.
Write-Output '  pre-flight: running the drain once, by hand...'
$pre = & node (Join-Path $Proj 'tasks\lab_queue.cjs') '--status' 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Output ('  ABORT: lab_queue.cjs --status exited {0}:' -f $LASTEXITCODE)
    Write-Output ('    ' + (($pre | Out-String).Trim()))
    exit 1
}
Write-Output ('    ok - ' + ((($pre | Out-String).Trim() -split "`n") | Where-Object { $_ -match 'queue:' } | Select-Object -First 1))
Write-Output ''

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output ('  A task named "{0}" ALREADY EXISTS (state: {1}).' -f $TaskName, $existing.State)
    if (-not $Force) {
        Write-Output '  REFUSING to touch it. This script does not delete or overwrite a task you'
        Write-Output '  did not ask it to. Re-run with -Execute -Force to replace it; the existing'
        Write-Output '  definition will be exported to tasks\logs first, so nothing is lost.'
        Write-Output ''
        exit 2
    }
}

if (-not $Execute) {
    Write-Output '  DRY RUN. Nothing was changed. Re-run with -Execute to register.'
    Write-Output ''
    exit 0
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }

# BACKUP BEFORE REPLACE. Rule: copy before you rewrite, and verify the copy exists
# before doing anything irreversible.
if ($existing -and $Force) {
    $stamp  = Get-Date -Format 'yyyyMMdd_HHmmss'
    $backup = Join-Path $LogDir ('SmartEntry-Lab-Drain.' + $stamp + '.xml')
    Export-ScheduledTask -TaskName $TaskName | Out-File -FilePath $backup -Encoding utf8
    if (-not (Test-Path $backup)) {
        Write-Output '  ABORT: could not write the backup of the existing task. Nothing changed.'
        exit 1
    }
    Write-Output ('  existing definition exported -> {0}' -f $backup)
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output '  existing task removed (its definition is preserved in the file above)'
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Max {1}' -f $Script, $Max) `
    -WorkingDirectory $Proj

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration $Duration

# IgnoreNew: a slow drain must NEVER have a second copy started on top of it. Two
# drains would run the same queued job twice and register it as two distinct runs,
# which would corrupt the trial count - the one number this whole lab rests on.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit $RunLimit

$me = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description ('Runs queued Strategy Lab backtests out of band, at most {0} per tick. Reads historical CSVs and writes assessment artifacts under tasks/analysis/lab. Touches no live config, contacts no broker, and cannot change what trades.' -f $Max) | Out-Null

Write-Output ('  REGISTERED: {0}' -f $TaskName)

$check = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $check) {
    Write-Output '  VERIFY FAILED: the task is not readable back. Investigate before relying on it.'
    exit 1
}
Write-Output ('  verified   : state {0}' -f $check.State)
Write-Output ''
Write-Output '  Check it with:'
Write-Output ("    Get-ScheduledTask -TaskName '{0}' | Get-ScheduledTaskInfo" -f $TaskName)
Write-Output ('    Get-Content "{0}" -Tail 20' -f (Join-Path $LogDir 'lab_drain.txt'))
Write-Output ''
exit 0
