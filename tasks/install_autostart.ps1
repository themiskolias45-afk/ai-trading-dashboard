# Installs the autostart that actually fires when you open the laptop, and clears
# the battery restrictions that were silently refusing the existing tasks.
#
# Run it once:  powershell -NoProfile -ExecutionPolicy Bypass -File tasks\install_autostart.ps1
# Safe to re-run. Deletes nothing.
#
# THE TWO PROBLEMS THIS FIXES (both verified on 2026-08-02)
#
# 1. Every existing autostart route fired on LOGON only - the Startup folder
#    shortcuts and the SmartEntryPro scheduled task. Opening a laptop lid is a
#    resume and an unlock, not a logon: no trigger fires and the Startup folder is
#    not re-read. The machine had been up 18 days, so nothing had auto-started
#    since 15 July and the stack was only running because it was launched by hand.
#
# 2. SmartEntryPro carried DisallowStartIfOnBatteries and StopIfGoingOnBatteries.
#    On battery, Task Scheduler REFUSES the task and records LastTaskResult
#    2147946720 (0x800710E0, "the operator or administrator has refused the
#    request") - that code was sitting on five of the eight SmartEntry tasks. It
#    also stops a running task the moment the charger comes out.
#
# The new task points at ensure_running.ps1, which starts only what is missing and
# never kills anything, so firing it on unlock and every few minutes is safe.

$ErrorActionPreference = 'Stop'

$Proj      = 'C:\Users\User\ai-trading-dashboard'
$Script    = Join-Path $Proj 'tasks\ensure_running.ps1'
$TaskName  = 'SmartEntry Ensure Running'
$REPEAT_MINUTES = 10
# Long enough that a repetition never expires in practice; [TimeSpan]::MaxValue is
# rejected by some PS 5.1 builds, so an explicit decade is used instead.
$REPEAT_DURATION = New-TimeSpan -Days 3650
$RUN_LIMIT       = New-TimeSpan -Minutes 30

# Every SmartEntry/JARVIS task, so the battery fix reaches the ones that already
# exist rather than only the new one.
$ExistingTasks = @(
    'SmartEntryPro',
    'JARVIS Morning Agent',
    'SmartEntry - Daily Check',
    'SmartEntry - Weekly Algo Review',
    'SmartEntry Data Backup',
    'SmartEntryVaultBackup',
    'SmartEntryVPSBackupPull',
    'SmartEntryVpsMonitor'
)

if (-not (Test-Path $Script)) {
    throw "ensure_running.ps1 not found at $Script"
}

$me = "$env:USERDOMAIN\$env:USERNAME"

# ---------------------------------------------------------------------------
# 1. Triggers
# ---------------------------------------------------------------------------
$triggers = @()

# Logon still matters: it is the only one that fires on a genuine cold boot.
$triggers += New-ScheduledTaskTrigger -AtLogOn -User $me

# The one that was missing. StateChange 8 = TASK_SESSION_UNLOCK. There is no
# New-ScheduledTaskTrigger switch for it, so the CIM class is built directly.
$unlockClass = Get-CimClass -ClassName MSFT_TaskSessionStateChangeTrigger `
                            -Namespace Root/Microsoft/Windows/TaskScheduler
$unlock = New-CimInstance -CimClass $unlockClass -ClientOnly
$unlock.StateChange = 8
$unlock.UserId      = $me
$unlock.Enabled     = $true
$triggers += $unlock

# Belt and braces: a resume that does NOT lock the workstation fires no unlock
# trigger either, so a plain repetition covers every remaining case.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval (New-TimeSpan -Minutes $REPEAT_MINUTES) `
            -RepetitionDuration $REPEAT_DURATION
$triggers += $repeat

# ---------------------------------------------------------------------------
# 2. Register
# ---------------------------------------------------------------------------
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`"" `
    -WorkingDirectory $Proj

# IgnoreNew: a slow run must never have a second copy started on top of it.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit $RUN_LIMIT

# Interactive, not SYSTEM: the bridges drive MetaTrader's GUI and must live in the
# desktop session. That is also why no elevation is needed to register this.
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Replaced existing task: $TaskName"
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal `
    -Description 'Starts any missing SmartEntry component (server, MT5 terminals, bridges A and B, watchdog guardian, VPS tunnel). Fills gaps only - never kills anything. Fires at logon, on workstation unlock, and every few minutes.' | Out-Null

Write-Output "Registered: $TaskName"
Write-Output "  triggers: logon, session unlock, every $REPEAT_MINUTES minutes"

# ---------------------------------------------------------------------------
# 3. Clear the battery restrictions on the tasks that already existed
# ---------------------------------------------------------------------------
foreach ($name in $ExistingTasks) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Output "  SKIP $name (not registered on this machine)"
        continue
    }
    $s = $task.Settings
    $before = "battery-block=$($s.DisallowStartIfOnBatteries) stop-on-battery=$($s.StopIfGoingOnBatteries) start-when-available=$($s.StartWhenAvailable)"
    if (-not $s.DisallowStartIfOnBatteries -and -not $s.StopIfGoingOnBatteries -and $s.StartWhenAvailable) {
        Write-Output "  OK   $name already unrestricted"
        continue
    }
    $s.DisallowStartIfOnBatteries = $false
    $s.StopIfGoingOnBatteries     = $false
    $s.StartWhenAvailable         = $true
    try {
        Set-ScheduledTask -TaskName $name -Settings $s | Out-Null
        Write-Output "  FIX  $name  ($before)"
    } catch {
        # A task registered by another user or requiring elevation will refuse.
        # Report it rather than failing the whole install.
        Write-Output "  WARN $name could not be updated: $($_.Exception.Message)"
    }
}

Write-Output ''
Write-Output 'Done. Verify with:'
Write-Output "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output '  Get-Content tasks\logs\ensure_running.txt -Tail 20'
