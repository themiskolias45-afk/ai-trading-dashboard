# Registers "SmartEntry H4 Agreement Watch" - the job that runs tasks\h4_agreement_watch.cjs.
#
# WHY THIS EXISTS. On 2026-09-08 all three assets sat at confidence 40 against a gate of
# 70 on both boxes, in a cohort whose CEILING is 55 - so nothing could fire however good
# the setup, until H4 stopped saying WAIT. The moment that changes is the thing worth
# knowing, and nothing was watching for it.
#
# IT IS READ-ONLY. The watch reads /api/signals and /api/strategy-settings, writes its own
# state file, and sends one Telegram. It places no order, moves no gate, clears no halt.
#
# SPAM IS BOUNDED BY THE RISING EDGE, NOT BY THE INTERVAL. At 10 minutes this fires ~144
# times a day and alerts only when an asset crosses the cohort ceiling upward - at most
# three messages, one per asset, until it falls back. tasks\h4_agreement_state.json holds
# that baseline and is written ONLY after a confirmed send, so a refused Telegram leaves
# the transition still unreported instead of silently swallowing the one alert that
# mattered.
#
# RE-RUNNING THIS IS SAFE. It refuses to touch an existing task rather than recreating it:
# schtasks /create /f and Unregister-ScheduledTask are both deletes, and this project does
# not delete. Pass -Update to rewrite the action in place.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tasks\register_h4_watch_task.ps1
#
# ASCII ONLY, DELIBERATELY - Windows PowerShell 5.1 reads a .ps1 as ANSI without a BOM,
# and one em-dash in a double-quoted string breaks the parse.

param(
    # Rewrite an already-registered task's action IN PLACE via Set-ScheduledTask. A modify,
    # never a delete: /create /f and Unregister both destroy the task's run history.
    [switch]$Update
)

$ErrorActionPreference = "Stop"

$name = "SmartEntry H4 Agreement Watch"

# DERIVED, NEVER HARDCODED. The laptop is C:\Users\User\ai-trading-dashboard under "User";
# the VPS is C:\ai-trading-dashboard under "administrator". A pinned path is the defect
# that made mt5_ensure_running.ps1 write nowhere for three hours while logging success.
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($cand in @("C:\Program Files\nodejs\node.exe", "C:\Program Files (x86)\nodejs\node.exe")) {
        if (Test-Path $cand) { $node = $cand; break }
    }
}
if (-not $node) { Write-Output "MISSING - node.exe not on PATH and not in Program Files"; exit 1 }

# BARE USERNAME, no domain prefix. "$env:USERDOMAIN\$env:USERNAME" fails on the VPS with
# HRESULT 0x80070534 because its USERDOMAIN is WORKGROUP, not a resolvable authority.
$account = $env:USERNAME
$log = Join-Path $repo "tasks\logs\h4_agreement_watch.txt"

$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing -and -not $Update) {
    Write-Output "EXISTS - '$name' is already registered (state: $($existing.State)). Not recreating."
    Write-Output "         Pass -Update to rewrite its action in place (Set-ScheduledTask, never a delete)."
    exit 0
}

# VERIFY BEFORE ACTING. This is the whole difference between this file and the ones that
# reported success while doing nothing.
foreach ($p in @($node, (Join-Path $repo "tasks\h4_agreement_watch.cjs"))) {
    if (-not (Test-Path $p)) { Write-Output "MISSING - $p"; exit 1 }
}
$logDir = Split-Path $log -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# TWO separate encoding settings, and BOTH are needed. node emits UTF-8; PowerShell decodes
# a native command's output with [Console]::OutputEncoding (the OEM codepage) BEFORE
# Out-File sees it, so -Encoding utf8 alone still writes mojibake.
$inner = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
         "& '$node' '$repo\tasks\h4_agreement_watch.cjs' --notify 2>&1 | Out-File -FilePath '$log' -Append -Encoding utf8"
$arg = '-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"'

$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(7) `
                                    -RepetitionInterval (New-TimeSpan -Minutes 10)
# Limited matches every other SmartEntry task on both boxes. Highest would need an
# elevation Windows refuses to grant Set-ScheduledTask, and nothing here needs it.
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                          -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable

if ($existing -and $Update) {
    Set-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings | Out-Null
    Write-Output "UPDATED - '$name' action rewritten in place; run history preserved"
    Write-Output "  repo    $repo"
    Write-Output "  node    $node"
    exit 0
}

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description "Alerts when an asset leaves the dead cohort - confidence above the 55 ceiling, meaning H4 has lined back up with the daily. Rising edge only. Read-only: places no order, moves no gate, clears no halt." | Out-Null

Write-Output "REGISTERED - '$name', every 10 minutes, --notify"
Write-Output "  repo    $repo"
Write-Output "  node    $node"
Write-Output "  account $account"
