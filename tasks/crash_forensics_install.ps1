<#
    Install the crash-forensics collector. RUN THIS IN AN ELEVATED POWERSHELL.

    WHY IT IS A SEPARATE SCRIPT. On 2026-09-08 the agent session tried to register the
    task itself and Windows refused twice - Register-ScheduledTask and schtasks both
    returned "Access is denied", because creating a task in the root folder needs admin
    and the session had none. Rather than pretend that worked, the two steps that need
    elevation are collected here so they are done once, visibly, by a human.

    WHAT IT DOES - both additive, both reversible, neither deletes anything:

      1. Registers the scheduled task "SmartEntry Crash Forensics", which runs
         tasks\crash_forensics.cjs 2 minutes after logon and again daily at 08:00.
         Elevated, so it can read C:\Windows\Minidump - unelevated it hits EPERM and
         cannot rescue a dump.

      2. Raises HKLM CrashControl\MinidumpsCount from 5 to 50. This ONLY increases how
         many crash dumps Windows keeps. It cannot reduce retention and it changes
         nothing about how the machine boots, sleeps or runs.

    WHAT IT DELIBERATELY DOES NOT DO. It does not touch Memory Integrity / VBS, Fast
    Startup, Storage Sense, the power plan, any driver, or anything belonging to the
    trading stack. Those are decisions, not installs.

    IF THE TASK ALREADY EXISTS it is reported and LEFT ALONE. It is never deleted and
    never recreated - schtasks /create /f is a delete in disguise.

    TO UNDO, in the same elevated window:
      Unregister-ScheduledTask -TaskName 'SmartEntry Crash Forensics' -Confirm:$false
      Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl' -Name MinidumpsCount -Value 5
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'SmartEntry Crash Forensics'
$Repo     = 'C:\Users\User\ai-trading-dashboard'
$Script   = Join-Path $Repo 'tasks\crash_forensics.cjs'

# 50 dumps at roughly 1 MB each. Large enough that a bad month cannot roll off the end,
# small enough that it can never matter on a disk with hundreds of GB free.
$TargetMinidumpsCount = 50

function Write-Step { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

# --- guard: elevation -------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'NOT ELEVATED. Close this, open PowerShell as Administrator, and run it again.' -ForegroundColor Red
    Write-Host 'Nothing was changed.' -ForegroundColor Red
    exit 1
}

# --- guard: the collector must actually be there ----------------------------------
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

# --- step 1: the scheduled task ---------------------------------------------------
Write-Step 'Scheduled task'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Already registered (state=$($existing.State), RunLevel=$($existing.Principal.RunLevel))." -ForegroundColor Yellow
    Write-Host 'Left exactly as it is. Nothing deleted, nothing recreated.' -ForegroundColor Yellow
} else {
    $action = New-ScheduledTaskAction -Execute $node -Argument 'tasks\crash_forensics.cjs' -WorkingDirectory $Repo

    $atLogon = New-ScheduledTaskTrigger -AtLogOn
    $atLogon.Delay = 'PT2M'          # let Ensure Running restore the trading stack first
    $daily = New-ScheduledTaskTrigger -Daily -At '08:00'

    # StartWhenAvailable so a missed run after a crash is caught up rather than skipped -
    # a forensics job that silently skips the boot after a crash is worse than useless.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                             -StartWhenAvailable `
                                             -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                                            -LogonType Interactive -RunLevel Highest

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atLogon,$daily `
        -Settings $settings -Principal $principal `
        -Description 'Copies Windows crash dumps into tasks\crash_dumps and appends every unexpected shutdown to tasks\crash_ledger.jsonl, before Storage Sense deletes them. Read-only on the system, append-only on its own ledger, always exits 0.' | Out-Null

    $check = Get-ScheduledTask -TaskName $TaskName
    Write-Host "Registered. state=$($check.State) RunLevel=$($check.Principal.RunLevel) triggers=$($check.Triggers.Count)" -ForegroundColor Green
}

# --- step 2: dump retention -------------------------------------------------------
Write-Step 'Dump retention'
$crashControl = 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl'
$current = (Get-ItemProperty $crashControl -Name MinidumpsCount -ErrorAction SilentlyContinue).MinidumpsCount

if ($null -ne $current -and [int]$current -ge $TargetMinidumpsCount) {
    Write-Host "MinidumpsCount is already $current - left alone (this script only ever raises it)." -ForegroundColor Yellow
} else {
    Set-ItemProperty $crashControl -Name MinidumpsCount -Value $TargetMinidumpsCount -Type DWord
    $now = (Get-ItemProperty $crashControl -Name MinidumpsCount).MinidumpsCount
    Write-Host "MinidumpsCount $current -> $now" -ForegroundColor Green
}

# --- prove it runs ----------------------------------------------------------------
Write-Step 'Running the collector once, elevated'
Push-Location $Repo
try { & $node 'tasks\crash_forensics.cjs' } finally { Pop-Location }

Write-Step 'Done'
Write-Host 'To undo:' -ForegroundColor Cyan
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Host "  Set-ItemProperty '$crashControl' -Name MinidumpsCount -Value 5"
