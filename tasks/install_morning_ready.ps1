# Register "SmartEntry Morning Ready" on LOGON + UNLOCK.
#
# WHY BOTH TRIGGERS, and why this is not negotiable:
# Opening a laptop lid is a RESUME and an UNLOCK, not a logon. A logon-only trigger
# never fires, and the work silently does not happen -- on 2026-08-02 this machine had
# been up for 18 days, so nothing had auto-started since 15 July and the whole stack
# was only ever running because somebody launched it by hand. A session-state-change
# trigger is what makes "as soon as I open the laptop" actually mean that.
#
# The task itself is guarded to run its work ONCE PER DAY (a flag file in tasks\), so
# firing on every unlock is cheap: the second and later runs exit immediately.
#
# Re-running this installer is safe -- it replaces the registration in place.

$ErrorActionPreference = 'Stop'
$proj   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $proj 'tasks\morning_ready.ps1'
$name   = 'SmartEntry Morning Ready'

if (-not (Test-Path $script)) {
    Write-Host "REFUSED: $script does not exist" -ForegroundColor Red
    exit 1
}

# Parse before registering. A task that points at a script with a syntax error is a
# task that fails silently every single morning.
$parseErrors = $null
$tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors -and $parseErrors.Count -gt 0) {
    Write-Host "REFUSED: $script has parse errors:" -ForegroundColor Red
    $parseErrors | ForEach-Object { Write-Host ("  line " + $_.Extent.StartLineNumber + ": " + $_.Message) }
    exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"')

$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
    # Console unlock: the one that actually fires when a lid is opened.
    (New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskSessionStateChangeTrigger `
        -Namespace Root/Microsoft/Windows/TaskScheduler) -ClientOnly -Property @{
            Enabled     = $true
            StateChange = 8          # TASK_SESSION_STATE_CHANGE_TYPE: SessionUnlock
            UserId      = "$env:COMPUTERNAME\$env:USERNAME"
        })
)

# Delay 90s so the network, the server and Edge have a chance to come up first. Without
# it the run lands on a half-booted box and reports failures that are really earliness.
foreach ($t in $triggers) {
    try { $t.Delay = 'PT90S' } catch { }
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal -Force | Out-Null

$task = Get-ScheduledTask -TaskName $name
Write-Host ("REGISTERED: " + $task.TaskName + "  state=" + $task.State) -ForegroundColor Green
Write-Host "  triggers:"
$task.Triggers | ForEach-Object {
    Write-Host ("    " + $_.CimClass.CimClassName + "  delay=" + $_.Delay)
}
Write-Host "  action: powershell -File $script"
Write-Host ""
Write-Host "It runs its work once per day; later unlocks exit immediately."
Write-Host "Force a run:  `$env:JARVIS_FORCE_MORNING='1'; .\tasks\morning_ready.ps1"
