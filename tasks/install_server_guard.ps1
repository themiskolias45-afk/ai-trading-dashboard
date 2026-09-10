# Register "SmartEntry Server Guard" - the only task on this box that can run with
# nobody signed in.
#
#   Run ELEVATED:
#     powershell -ExecutionPolicy Bypass -File tasks\install_server_guard.ps1
#   Report only, change nothing:
#     powershell -ExecutionPolicy Bypass -File tasks\install_server_guard.ps1 -DryRun
#
# ASCII ONLY - PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#
# WHY ELEVATION IS REQUIRED, measured 2026-09-10 on this box
#   Register-ScheduledTask with -LogonType Interactive  -> REGISTERED
#   Register-ScheduledTask with -LogonType S4U          -> Access is denied
#   Same user, same action, same trigger. S4U is the whole point: it is what lets the
#   task run with no interactive session. Registering it as Interactive instead would
#   reproduce the exact bug this is here to fix, so this script refuses rather than
#   silently installing a decoration. See the vault note on the battery flag - Windows
#   denies the same class of change there for the same reason.
#
# WHAT IT INSTALLS
#   Trigger:   AtStartup, plus every 5 minutes indefinitely
#   Principal: current user, S4U, RunLevel Limited (no elevation needed AT RUN TIME -
#              the server has always run as this user at Limited)
#   Action:    tasks\server_guard.ps1 - server only. No MT5, no bridges, no GUI.
#
# It creates a NEW task. It does not touch "SmartEntry Ensure Running" or any of the
# other 65 tasks, because ensure_running.ps1 starts the MT5 terminal with no
# UserInteractive guard (line 179) and would launch it into session 0 under S4U.

param(
    [switch]$DryRun,
    [string]$TaskName = 'SmartEntry Server Guard'
)

$ErrorActionPreference = 'Stop'

$Proj      = Split-Path -Parent $PSScriptRoot
$GuardPath = Join-Path $Proj 'tasks\server_guard.ps1'
$BackupDir = Join-Path $Proj 'tasks\logs'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host "install_server_guard  box=$env:COMPUTERNAME  elevated=$isAdmin  dryRun=$DryRun"

if (-not (Test-Path $GuardPath)) {
    Write-Host "REFUSING: $GuardPath not found."
    exit 2
}

# Prove the script parses before wiring a task to it. A task pointed at a file that
# cannot parse fails silently every 5 minutes forever.
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content $GuardPath -Raw), [ref]$null)
Write-Host "  server_guard.ps1 parses OK"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  existing task found: logonType=$($existing.Principal.LogonType) runLevel=$($existing.Principal.RunLevel)"
    # Never overwrite blind. Standing rule 4: copy before you rewrite.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $out   = Join-Path $BackupDir ("schtask-backup-ServerGuard-$stamp.xml")
    if (-not $DryRun) {
        [System.IO.File]::WriteAllText($out, (Export-ScheduledTask -TaskName $TaskName), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "  exported old definition -> $out"
    }
    if ($existing.Principal.LogonType -eq 'S4U') {
        Write-Host "Nothing to do: already registered S4U."
        exit 0
    }
}

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "REFUSING: not elevated, and S4U registration is denied without it."
    Write-Host "Measured on this box: Interactive registers fine, S4U returns 'Access is denied'."
    Write-Host "Installing it as Interactive would recreate the bug, so nothing was changed."
    Write-Host ""
    Write-Host "Re-run from an ADMIN PowerShell:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit 3
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $GuardPath)

# Two triggers, and both are load-bearing. AtStartup covers the crash-reboot that
# started all this. The 5-minute repeat covers a server that dies without the box
# rebooting, which is the more common case.
$trgBoot = New-ScheduledTaskTrigger -AtStartup
$trgRep  = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) `
                                    -RepetitionInterval (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                                        -LogonType S4U -RunLevel Limited

# AllowStartIfOnBatteries matters here specifically: 5 of the 7 unexpected shutdowns in
# the 72h to 2026-09-10 were clean power loss with BugcheckCode=0, i.e. this laptop
# runs on battery. A recovery task that declines to run on battery would be missing at
# exactly the moment it is needed.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                         -StartWhenAvailable -MultipleInstances IgnoreNew `
                                         -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

if ($DryRun) {
    Write-Host "  would register: S4U / Limited / AtStartup + every 5 min"
    Write-Host "DRY RUN - nothing was changed."
    exit 0
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trgBoot, $trgRep) `
    -Principal $principal -Settings $settings -Force `
    -Description 'Headless. Starts the SmartEntry server if it is not answering. Boot + every 5 min. Server only - no MT5, no bridges, no GUI.' | Out-Null

$after = Get-ScheduledTask -TaskName $TaskName
Write-Host "  after: user=$($after.Principal.UserId) logonType=$($after.Principal.LogonType) runLevel=$($after.Principal.RunLevel)"
foreach ($tr in $after.Triggers) { Write-Host "  trigger: $($tr.CimClass.CimClassName)" }

if ($after.Principal.LogonType -ne 'S4U') {
    Write-Host "WARNING: logonType is $($after.Principal.LogonType), not S4U. It will NOT run headless."
    exit 1
}

# Run it once now. An exit code is not proof the guard works - the log line is.
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8
$log = Join-Path $Proj 'tasks\logs\server_guard.txt'
if (Test-Path $log) {
    Write-Host ""
    Write-Host "last guard log line:"
    Get-Content $log -Tail 1
} else {
    Write-Host "WARNING: no $log yet - the task ran but wrote nothing. Check it by hand."
}

Write-Host ""
Write-Host "done. Real proof comes at the next reboot: the server must come back with"
Write-Host "nobody signed in. Check with:  Get-Content tasks\logs\server_guard.txt -Tail 5"
Write-Host "and look for a 'headless session' line."
