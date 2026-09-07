$ErrorActionPreference = 'Continue'

# ── 1. Make SmartEntryAutoStart actually able to fire ─────────────────────────
#
# It is Logon-triggered on a headless server, so it has never run once. Its script
# startup_vps.ps1 kills nothing and brings things up via Start-ScheduledTask, so a
# Boot trigger is safe. Resolving the RED by making the task run is honest; silencing
# the check would not be.
#
# 30s delay puts it BEFORE SmartEntryEnsureRunning's 2-minute boot delay, so the
# starter goes first and the gap-filler arrives afterwards to verify rather than to
# race it for the bridge.
$name = 'SmartEntryAutoStart'
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Output "SKIP: $name not registered"
} else {
    $existing = @($task.Triggers)
    $hasBoot  = @($existing | Where-Object { $_.CimClass.CimClassName -match 'Boot' }).Count -gt 0
    if ($hasBoot) {
        Write-Output "$name already has a boot trigger"
    } else {
        $boot = New-ScheduledTaskTrigger -AtStartup
        $boot.Delay = 'PT30S'
        try {
            Set-ScheduledTask -TaskName $name -Trigger (@($existing) + $boot) -ErrorAction Stop | Out-Null
            $after = (Get-ScheduledTask -TaskName $name).Triggers |
                     ForEach-Object { ($_.CimClass.CimClassName -replace 'MSFT_Task','' -replace 'Trigger','') }
            Write-Output ("$name triggers now: " + ($after -join ', '))
        } catch {
            Write-Output ("FAILED to add boot trigger: " + $_.Exception.Message)
        }
    }
}

# ── 2. Run the coverage audit daily, and make it visible ──────────────────────
$auditName   = 'SmartEntryCoverageAudit'
$auditScript = 'C:\ai-trading-dashboard\tasks\coverage_audit.ps1'
if (-not (Test-Path $auditScript)) { Write-Output 'ABORT: coverage_audit.ps1 missing'; exit 1 }

if (Get-ScheduledTask -TaskName $auditName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $auditName -Confirm:$false
}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$auditScript`""
# Twice a day, so a fault has at most ~12h of darkness rather than 24.
$trigger = New-ScheduledTaskTrigger -Daily -At '07:15'
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '07:15' `
                        -RepetitionInterval (New-TimeSpan -Hours 12)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
try {
    Register-ScheduledTask -TaskName $auditName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'Ask every SmartEntry component when it last did its job. Exit 1 on any RED.' `
        -ErrorAction Stop | Out-Null
    $t = Get-ScheduledTask -TaskName $auditName
    Write-Output ("registered: {0}  state={1}  repeat={2}" -f $t.TaskName, $t.State, $t.Triggers[0].Repetition.Interval)
} catch {
    Write-Output ('FAILED to register audit: ' + $_.Exception.Message)
}

Write-Output '--- audit after the fix ---'
& powershell -NoProfile -ExecutionPolicy Bypass -File $auditScript |
    Select-String -Pattern 'RED|checks:|AutoStart'
