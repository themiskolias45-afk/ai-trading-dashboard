# Clear the power condition that is refusing 7 SmartEntry tasks on battery.
# ASCII only. Backs up each task definition first, then applies, then verifies.
param([switch]$Execute)

$proj = 'C:\Users\User\ai-trading-dashboard'
$bak  = Join-Path $proj 'tasks\task_backups'
if (-not (Test-Path $bak)) { New-Item -ItemType Directory -Force $bak | Out-Null }

$names = @(
  'SmartEntry Pull VPS EA Status',
  'SmartEntry Trade Ledger Reconcile',
  'SmartEntry Medic',
  'SmartEntry EA CRT Weekly Review',
  'SmartEntry Pre-Open Score',
  'SmartEntry Verify Fixes',
  'SmartEntryPro'
)

$mode = if ($Execute) { 'EXECUTE' } else { 'DRY RUN' }
Write-Host "unblock_battery_tasks [$mode]"
Write-Host ''

foreach ($n in $names) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host ("MISSING: {0}" -f $n); continue }

    $safe = ($n -replace '[^A-Za-z0-9]', '_')
    $path = Join-Path $bak ($safe + '_THEMIS_20260907.xml')

    if ($Execute) {
        # BACK UP BEFORE CHANGING. Never rewrite without a copy first.
        if (-not (Test-Path $path)) {
            Export-ScheduledTask -TaskName $n | Out-File -Encoding utf8 $path
        }
        $s = $t.Settings
        # The three that matter, and only those. Everything else on Settings is left
        # exactly as found rather than rebuilt from a template.
        $s.DisallowStartIfOnBatteries = $false   # stop refusing the run on battery
        $s.StopIfGoingOnBatteries     = $false   # and stop killing one mid-flight
        $s.StartWhenAvailable         = $true    # catch up a slot that was missed
        Set-ScheduledTask -TaskName $n -Settings $s | Out-Null
    }

    $after = (Get-ScheduledTask -TaskName $n).Settings
    $info  = Get-ScheduledTask -TaskName $n | Get-ScheduledTaskInfo
    Write-Host ("{0,-34} disallowBatt={1,-5} stopOnBatt={2,-5} startWhenAvail={3,-5} missed={4}" -f `
        $n, $after.DisallowStartIfOnBatteries, $after.StopIfGoingOnBatteries, `
        $after.StartWhenAvailable, $info.NumberOfMissedRuns)
}

Write-Host ''
if (-not $Execute) { Write-Host 'DRY RUN - nothing changed. Re-run with -Execute.' }
else { Write-Host 'Applied. Backups in tasks\task_backups\.' }
