# Registers an executor as a scheduled task, DRY RUN unless -Arm is passed.
#
# WHY IT INSTALLS DRY BY DEFAULT. The executor has been run twice and both times there
# were no setups to act on, so nobody has yet seen it handle a real one. Scheduling it dry
# means the moment a setup appears the log carries the complete plan -- symbol, lots, stop,
# target, and every guard decision -- without an order existing. That is the cheapest
# possible way to find out whether it does the right thing, and this session has already
# found four cases where code that looked correct did nothing at all.
#
# -Arm switches it to --execute. Both accounts are demo.
#
#   powershell -ExecutionPolicy Bypass -File tasks\install_executor.ps1 -Model fvg
#   powershell -ExecutionPolicy Bypass -File tasks\install_executor.ps1 -Model tk -Arm
#   powershell -ExecutionPolicy Bypass -File tasks\install_executor.ps1 -Model fvg -Remove
#
# ASCII ONLY. PowerShell 5.1 reads a .ps1 as ANSI unless it carries a BOM, so a UTF-8
# em-dash becomes three bytes and can terminate a string mid-parse -- four parse errors
# from four characters, measured 2026-09-02.

param(
    [ValidateSet('fvg','tk')][string]$Model = 'fvg',
    [switch]$Arm,
    [switch]$Remove,
    # Concurrency was never modelled in the backtest -- every measurement assumed one
    # position at a time per model. Bounding it here rather than assuming it away, and
    # 1 for the first armed run so an undiscovered bug can produce at most one position.
    [int]$MaxOpen = 1
)

$ErrorActionPreference = 'Stop'
$TaskName = "SmartEntry Executor " + $Model.ToUpper()
$root     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $root 'tasks\fvg_executor.py'
$logFile  = Join-Path $root ('tasks\logs\' + $Model + '_executor.txt')

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        "Removed '$TaskName'."
    } else { "No task named '$TaskName'." }
    return
}

if (-not (Test-Path $script)) { throw "Executor not found at $script" }

# Python resolved by RUNNING it, never taken from PATH. A task that resolves to a
# different interpreter than the shell does fails in a way nobody sees.
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { throw "python not on PATH -- the task would register and never run." }
& $py --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "python at $py did not execute" }

$logDir = Split-Path -Parent $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$modeArgs = if ($Arm) { "--model $Model --execute --verbose" } else { "--model $Model --verbose" }
# Set in the task's own command so it applies to the scheduled run only, never to a shell
# where someone runs the executor by hand.
$envPrefix = "`$env:FVG_MAX_OPEN='$MaxOpen'; " 

# powershell.exe, not cmd.exe: cmd strips the outer quote pair of a /c string and the
# nested path quotes break before the interpreter starts -- measured, the task returned
# result 1 with no log at all.
$inner  = $envPrefix + "& '$py' '$script' " + $modeArgs + " 2>&1 | Out-File -FilePath '$logFile' -Append -Encoding ascii"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"') `
    -WorkingDirectory $root

# 5 minutes. The FVG freshness window is one m15 bar, so a slower cadence would let a valid
# setup expire unseen; TK's window is a 4h bar and is unaffected by checking often.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew

# whoami, not $env:USERDOMAIN\$env:USERNAME: on the VPS those read WORKGROUP\administrator
# while the account is vmi3465345\administrator, and Register-ScheduledTask fails with
# HRESULT 0x80070534, "no mapping between account names and security IDs".
$me = (& whoami).Trim()
if (-not $me) { throw "whoami returned nothing - cannot determine the principal" }
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$desc = if ($Arm) { "$Model executor -- ARMED, places live orders on the demo account." }
        else { "$Model executor -- DRY RUN, logs the plan and places nothing." }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description $desc | Out-Null

$mode = if ($Arm) { "ARMED (--execute)" } else { "DRY RUN (places nothing)" }
"Registered '$TaskName' -- every 5 minutes, $mode, max $MaxOpen open, as $me."
"  executor : $script --model $Model"
"  log      : $logFile"
if (-not $Arm) { "  to arm   : re-run this with -Arm" }
