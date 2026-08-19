# Make SmartEntryServer able to start on a headless box.
#
#   powershell -File tasks\fix_server_task_principal.ps1              # dry run
#   powershell -File tasks\fix_server_task_principal.ps1 -Execute
#
# ASCII ONLY. PowerShell 5.1 reads a .ps1 as ANSI without a BOM, so an em-dash arrives
# carrying a quote character and the file stops parsing.
#
# THE PROBLEM, measured on the VPS 2026-08-19
#
#   SmartEntryServer:  LogonType=InteractiveToken   Trigger=AtLogOn ONLY
#                      LAST_RESULT=0x800710E0  (ERROR_NO_INTERACTIVE_SESSION)
#
# The task demands an interactive desktop session. The VPS is headless and nobody signs
# in, so the task CANNOT START THE SERVER. A Start-ScheduledTask against it fails with
# that code, which is exactly why a restart attempt left startedAt unchanged at
# 08-18T09:17 while reporting nothing obviously wrong.
#
# It also has no boot trigger, so a reboot leaves the box dead until someone logs in.
# Same family as the logon-only sweep that already bit this fleet once.
#
# WHY SYSTEM IS SAFE HERE, ON EVIDENCE RATHER THAN HOPE
# SmartEntryEnsureRunning already runs as SYSTEM/ServiceAccount every 10 minutes, and
# tasks\ensure_running.ps1 launches "node index.js" from it successfully - so SYSTEM can
# resolve node, read keys.env and start this exact server. start_server_vps.bat uses
# absolute paths throughout, so it does not depend on a user profile either.
#
# AND THE CHANGE CANNOT MAKE THINGS WORSE
# The task fails 100% of the time today. Worst case after this, it still fails and
# SmartEntryEnsureRunning recovers the server within 10 minutes exactly as it does now.
# Best case, restarts and reboots start working. There is no downside branch.
#
# It does NOT touch the running server, the bridges, or any position. It edits one
# scheduled-task definition and exports the old one first.

param(
    [switch]$Execute,
    [string]$TaskName = 'SmartEntryServer',
    [string]$BackupDir = 'C:\vps-predeploy-backup\scheduled-tasks'
)

$ErrorActionPreference = 'Stop'
$mode = if ($Execute) { 'EXECUTE' } else { 'DRY RUN' }
Write-Host "fix_server_task_principal [$mode]  task=$TaskName  box=$env:COMPUTERNAME"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "REFUSING: no scheduled task named '$TaskName' on this box."
    Write-Host "The laptop has no SmartEntryServer task and relies on 'SmartEntry Ensure Running'."
    exit 2
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "  before: user=$($task.Principal.UserId) logonType=$($task.Principal.LogonType) runLevel=$($task.Principal.RunLevel)"
Write-Host "  lastResult=$($info.LastTaskResult) (0x$('{0:X}' -f $info.LastTaskResult))  lastRun=$($info.LastRunTime)"
foreach ($tr in $task.Triggers) { Write-Host "  trigger: $($tr.CimClass.CimClassName)" }

$alreadySystem = $task.Principal.LogonType -eq 'ServiceAccount'
$hasBoot = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count -gt 0
if ($alreadySystem -and $hasBoot) {
    Write-Host "Nothing to do: already ServiceAccount with a boot trigger."
    exit 0
}

Write-Host "  would set: user=SYSTEM logonType=ServiceAccount runLevel=Highest"
if (-not $hasBoot) { Write-Host "  would ADD an AtStartup trigger (keeping the existing one)" }

if (-not $Execute) {
    Write-Host "DRY RUN. Re-run with -Execute. The old definition is exported first."
    exit 0
}

# Export before touching it. Never delete, always keep a way back.
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $BackupDir ("$TaskName-$stamp.xml")
$xml = Export-ScheduledTask -TaskName $TaskName
[System.IO.File]::WriteAllText($outFile, $xml, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  exported old definition -> $outFile"
Write-Host "  restore with: Register-ScheduledTask -Xml (Get-Content '$outFile' -Raw) -TaskName '$TaskName' -Force"

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$triggers  = @($task.Triggers)
if (-not $hasBoot) { $triggers += (New-ScheduledTaskTrigger -AtStartup) }

Set-ScheduledTask -TaskName $TaskName -Principal $principal -Trigger $triggers | Out-Null

$after = Get-ScheduledTask -TaskName $TaskName
Write-Host "  after:  user=$($after.Principal.UserId) logonType=$($after.Principal.LogonType) runLevel=$($after.Principal.RunLevel)"
foreach ($tr in $after.Triggers) { Write-Host "  trigger: $($tr.CimClass.CimClassName)" }

# The running server is untouched by a definition change - confirm that, so nobody has
# to wonder whether editing the task disturbed the box that trades.
try {
    $s = Invoke-RestMethod 'http://localhost:3001/api/status' -TimeoutSec 8
    Write-Host "  server still up, startedAt=$($s.startedAt) (unchanged by this edit, as expected)"
} catch {
    Write-Host "  WARNING: server not answering. This edit does not stop it - check separately."
}

Write-Host ""
Write-Host "done. The task can now start headless. Proof comes at the next restart or reboot:"
Write-Host "  powershell -File tasks\safe_server_restart.ps1 -Execute"
Write-Host "and startedAt must CHANGE. A task exit code is not proof - read /api/status."
