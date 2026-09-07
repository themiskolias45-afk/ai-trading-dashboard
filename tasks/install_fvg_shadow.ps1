# Registers the FVG continuation shadow runner as a scheduled task.
#
# WHY --once ON A SCHEDULE rather than the runner's own setInterval loop: a long-lived
# node process dies with the shell that started it, leaves an orphan when it does not,
# and does not come back after a reboot. A 15-minute task has none of those properties
# and matches the execution timeframe -- checking more often cannot find a setup that
# needs a closed m15 bar to exist.
#
# SHADOW ONLY. The runner places no orders, touches no gate, threshold, position, setting
# or learning file, and writes exactly one append-only file: tasks/fvg_shadow.jsonl.
# Registering this cannot change what trades.
#
#   powershell -ExecutionPolicy Bypass -File tasks\install_fvg_shadow.ps1
#   powershell -ExecutionPolicy Bypass -File tasks\install_fvg_shadow.ps1 -Remove
#
# Runs at Limited level as the current user -- it needs no elevation, and asking for it
# would be a reason for someone to skip installing it.

param([switch]$Remove, [ValidateSet('fvg','tk','crt')][string]$Model = 'fvg')

$ErrorActionPreference = 'Stop'
# One installer, either model. TK evaluates CLOSED 4-HOUR bars so a 15-minute cadence
# would re-check the same bar 15 times; 30 minutes still catches a bar close promptly
# without the noise. The dedupe key is the bar time, so a duplicate check records nothing.
# CRT+FVG enters on an m15 retest exactly as FVG continuation does, so it takes the same
# 15-minute cadence. Its BIAS is h4, but the bias only selects which sweep is in play --
# the bar that must not be missed is the m15 one price retests on.
$TaskName = switch ($Model) { 'tk' { 'SmartEntry TK Shadow' } 'crt' { 'SmartEntry CRT Shadow' } default { 'SmartEntry FVG Shadow' } }
$RunnerFile = switch ($Model) { 'tk' { 'tk_runner.cjs' } 'crt' { 'crt_runner.cjs' } default { 'fvg_runner.cjs' } }
$IntervalMin = if ($Model -eq 'tk') { 30 } else { 15 }
$root     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $root ('tasks\' + $RunnerFile)
$logFile  = Join-Path $root ('tasks\logs\' + $Model + '_shadow.txt')

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        "Removed scheduled task '$TaskName'."
    } else {
        "No task named '$TaskName' -- nothing to remove."
    }
    return
}

if (-not (Test-Path $script)) { throw "Runner not found at $script" }

# Resolve node by RUNNING it, never by trusting PATH: a task that resolves to a different
# node than the shell does is the kind of difference nobody sees until it fails silently.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not on PATH -- the task would be registered and never run." }
& $node --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "node at $node did not execute" }

$logDir = Split-Path -Parent $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# ASCII, not the default: PowerShell 5.1's *>> writes UTF-16LE with a BOM and every
# grep against the log then matches nothing, which reads as a quiet system.
# Output is appended, never overwritten: the shadow record is the whole point and a task
# that truncates its own log loses the evidence it exists to collect.
#
# EXECUTED THROUGH powershell.exe, NOT cmd.exe. The first version used
# `cmd.exe /c "node" "script" --once >> "log"` and the task returned result 1 with no log
# at all: cmd strips the outer quote pair of a /c string, so the nested quotes around the
# paths broke the command before node ever started. A task that is registered and silently
# never runs is worse than no task, because the absence of setups reads as a quiet market.
# Same executor install_autostart.ps1 uses, for the same reason.
$inner  = "& '$node' '$script' --once 2>&1 | Out-File -FilePath '$logFile' -Append -Encoding ascii"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"') `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMin)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

# IDENTITY COMES FROM whoami, NOT $env:USERDOMAIN\$env:USERNAME. On the VPS those
# variables read WORKGROUPdministrator while the account is actually
# vmi3465345dministrator, so Register-ScheduledTask failed with HRESULT 0x80070534,
# "no mapping between account names and security IDs". whoami reports the name the SID
# actually resolves from, and is right on a domain-joined box, a workgroup box and here.
$me = (& whoami).Trim()
if (-not $me) { throw "whoami returned nothing - cannot determine the principal" }
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description ($Model.ToUpper() + ' shadow runner -- records setups only, places no orders.') | Out-Null

"Registered '$TaskName' -- every $IntervalMin minutes, as $me."
"  runner : $script"
"  log    : $logFile"
"  verify : Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
