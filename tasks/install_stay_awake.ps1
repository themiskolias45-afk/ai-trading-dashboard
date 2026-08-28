# Register "SmartEntry Stay Awake" - hold a system-required power request while the
# trading server is answering, so this laptop stops hibernating through its own jobs.
#
#   powershell -File tasks\install_stay_awake.ps1
#   powershell -File tasks\install_stay_awake.ps1 -Remove
#
# ASCII ONLY - PS 5.1 reads a BOM-less .ps1 as ANSI.
#
# LAPTOP ONLY. The VPS is a server; it does not sleep and has no lid. Installing this
# there would hold a request forever for no reason.
#
# NO ELEVATION ANYWHERE. The holder uses SetThreadExecutionState, which is per-process and
# needs no admin, and the task runs as the interactive user at Limited run level. This is
# the narrow alternative to Option A in SLEEP-RUNBOOK.md, which needs elevation and keys
# off `node.exe` - a name shared by 66 unrelated processes on this box.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$name   = 'SmartEntry Stay Awake'
$script = Join-Path $PSScriptRoot 'stay_awake.ps1'

if ($Remove) {
    try {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "REMOVED: $name. Nothing else changed - the power request dies with the process." -ForegroundColor Yellow
    } catch {
        Write-Host "Not registered, nothing to remove." -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Test-Path $script)) {
    Write-Host "REFUSED: $script not found" -ForegroundColor Red
    exit 1
}

# Refuse to schedule a script that cannot parse. A holder that dies on its first unattended
# start would leave the box sleeping exactly as before, with a green task to say otherwise.
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
    Write-Host "REFUSED: $script has parse errors:" -ForegroundColor Red
    $parseErrors | ForEach-Object { Write-Host ("  line " + $_.Extent.StartLineNumber + ": " + $_.Message) }
    exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"')

# Logon AND console unlock. Opening the lid is the moment that matters on this box - the
# autostart runbook records that logon-only triggers never fire on a lid-open, which is
# how ensure_running came to have 34.8h of holes in 48 hours.
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
    (New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskSessionStateChangeTrigger `
        -Namespace Root/Microsoft/Windows/TaskScheduler) -ClientOnly -Property @{
            Enabled     = $true
            StateChange = 8          # SessionUnlock
            UserId      = "$env:COMPUTERNAME\$env:USERNAME"
        })
)

# ExecutionTimeLimit 0 = run indefinitely. This is a holder, not a job: a time limit would
# kill it mid-session and hand the machine back to hibernation silently.
# IgnoreNew so a second unlock cannot start a second holder.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal -Force | Out-Null

Start-ScheduledTask -TaskName $name

$task = Get-ScheduledTask -TaskName $name
Write-Host ("REGISTERED and STARTED: " + $task.TaskName + "  state=" + $task.State) -ForegroundColor Green
Write-Host "It holds SYSTEM-required only while the server answers on 3001, so stopping the"
Write-Host "stack lets this box sleep again within a minute. The display still sleeps normally."
Write-Host "Undo at any time:  powershell -File tasks\install_stay_awake.ps1 -Remove"
