<#
    Register the "SmartEntry Lab Shadow" scheduled task.

    WHY THIS EXISTS. tasks/lab_shadow.cjs runs staged lab candidates FORWARD on new bars
    and writes dashboard/lab-shadow.json. It was written, committed, and never scheduled
    on either box. The consequence, measured 2026-09-08: 4,094 lab trials had produced 8
    survivors and every one of them carried ZERO forward trades, so not one could be
    separated from luck. The discovery half of the lab worked; the validation half was
    wired to no trigger.

    Same failure shape as tasks/crash_forensics_install.ps1 documents for the crash
    collector, and as the confluence alert. A component that runs only when a human
    remembers it is a component that does not run.

    WHAT IT DOES - additive and reversible:
      Registers the task to run hourly, starting 3 minutes from now.

    WHAT IT DOES NOT DO. It places no orders, touches no gate, threshold, size or stop,
    and does not modify lab_shadow.cjs. lab_shadow is shadow-only by construction.

    IF THE TASK ALREADY EXISTS it is reported and LEFT ALONE - never deleted, never
    recreated. schtasks /create /f is a delete in disguise.

    TO UNDO:
      Unregister-ScheduledTask -TaskName 'SmartEntry Lab Shadow' -Confirm:$false
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'SmartEntry Lab Shadow'

# Resolved from THIS script's own location, so the same file works on the laptop
# (C:\Users\User\ai-trading-dashboard) and the VPS (C:\ai-trading-dashboard) without a
# hardcoded root. A hardcoded VPS path in mt5_ensure_running.ps1 is what made a writer
# write nowhere and log success for three hours on 2026-09-07.
$Repo   = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $Repo 'tasks\lab_shadow.cjs'

if (-not (Test-Path $Script)) {
    Write-Host "Collector not found at $Script - nothing was changed." -ForegroundColor Red
    exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) {
    Write-Host "node.exe not found - nothing was changed." -ForegroundColor Red
    exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Already registered (state=$($existing.State)). Left exactly as it is." -ForegroundColor Yellow
    exit 0
}

$action  = New-ScheduledTaskAction -Execute $node -Argument 'tasks\lab_shadow.cjs' -WorkingDirectory $Repo

# Hourly. The candidates fire between 0.06 and 0.42 trades a day, so a shorter interval
# would only add log lines; a longer one risks missing a bar-close window after a restart.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) `
                                    -RepetitionInterval (New-TimeSpan -Hours 1)

# StartWhenAvailable so a run missed while the box was down is caught up rather than
# skipped - a forward-evidence collector that silently skips is how the ledger stayed empty.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                         -StartWhenAvailable `
                                         -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings `
    -Description 'Runs staged lab candidates FORWARD on new bars and writes dashboard/lab-shadow.json. Shadow only: places no orders, touches no gate or size. Without it a staged candidate can never be separated from luck.' | Out-Null

$check = Get-ScheduledTask -TaskName $TaskName
Write-Host "Registered. state=$($check.State) triggers=$($check.Triggers.Count) repeat=hourly" -ForegroundColor Green
Write-Host "To undo:  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
