# Register "SmartEntry Engine Variant Watch" on whichever box this runs on.
#
# DAILY, not every 15 minutes, and that is deliberate: every variant replays DAILY bars,
# so a 15-minute cadence would recompute an identical answer ~96 times a day and file it
# as fresh evidence. The script also self-skips (exit 4) when the newest bar has not
# moved, so an extra run costs seconds, not two walk-forwards.
#
# 03:20 local — after the daily bar has closed on all three assets and clear of the
# 00:25 Strategy Search and the Sunday 09:00-10:10 robustness block, so two heavy
# replays never contend with another heavy job.
#
# Runs on battery, like every other measurement job: a laptop that unplugs must not stop
# measuring. Idempotent — re-running this re-registers the same definition.
param([switch]$Execute)

$ErrorActionPreference = 'Stop'
$name = 'SmartEntry Engine Variant Watch'
$proj = Split-Path -Parent $PSScriptRoot   # overridden below when run from tasks\

# Resolve the project root from a known file rather than trusting the caller's cwd.
foreach ($c in @('C:\Users\User\ai-trading-dashboard', 'C:\ai-trading-dashboard')) {
    if (Test-Path (Join-Path $c 'tasks\engine_variant_watch.cjs')) { $proj = $c; break }
}
$script = Join-Path $proj 'tasks\engine_variant_watch.cjs'
if (-not (Test-Path $script)) { Write-Output "MISSING: $script"; exit 1 }

# Full node path, never a bare 'node.exe'. A bare name resolves on the laptop and NOT
# under the VPS's SYSTEM principal, where the task then reports rc=0 and does nothing —
# this project has already been bitten by exactly that.
$node = $null
foreach ($c in @("$env:ProgramFiles/nodejs/node.exe", "C:/Program Files/nodejs/node.exe",
                 "$env:LOCALAPPDATA/Programs/nodejs/node.exe")) {
    if ($c -and (Test-Path $c)) { $node = $c; break }
}
if (-not $node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source } }
if (-not $node) { Write-Output 'MISSING: node.exe not found — refusing to register a task that cannot run'; exit 1 }

Write-Output "project : $proj"
Write-Output "node    : $node"
Write-Output "script  : $script"

if (-not $Execute) { Write-Output 'DRY RUN — re-run with -Execute to register.'; exit 0 }

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $proj
$trigger = New-ScheduledTaskTrigger -Daily -At '03:20'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                         -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
                                         -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

$t = Get-ScheduledTask -TaskName $name
$i = $t | Get-ScheduledTaskInfo
Write-Output ("REGISTERED {0} | state={1} next={2} battery-ok={3}" -f `
    $name, $t.State, $i.NextRunTime, (-not $t.Settings.DisallowStartIfOnBatteries))
