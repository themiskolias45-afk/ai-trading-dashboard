# Registers "SmartEntry Confluence Alert" — the job that actually RUNS the confluence table.
#
# WHY THIS EXISTS. tasks/confluence.cjs was built, committed and reported as done, and
# nothing on either box ever ran it. He asked for "message to telegram when atomic
# indicator, tradingview strategy and daily plan and system agree" — an alert nobody
# invokes is not an alert, it is a script. Measured 2026-09-08: zero scheduled tasks on
# either machine matched 'confluence'.
#
# IT IS READ-ONLY. The table places no order, moves no gate and writes no config. Its one
# POST is /api/size, which is a pure calculation. The only file it writes is its own
# dedupe state.
#
# SPAM IS BOUNDED BY THE DEDUPE, NOT BY THE INTERVAL. At 15 minutes this fires ~96 times
# a day; tasks/confluence_state.json caps delivery at one message per asset per direction
# per day, so the ceiling is six. That state file is in .gitignore on purpose — a
# git-tracked state file gets recreated by a pull and the RunLevel=Limited filtered token
# then loses append rights on it, which is what left the VPS ledgers unwritable for 17
# hours on 2026-09-08.
#
# RE-RUNNING THIS IS SAFE. It refuses to touch an existing task rather than recreating it:
# /create /f is a delete, and this project does not delete.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tasks\register_confluence_task.ps1

$ErrorActionPreference = "Stop"

$name = "SmartEntry Confluence Alert"

# DERIVED, NEVER HARDCODED. The first version of this file pinned the laptop's repo root
# and its "User" account. On the VPS — which lives at C:\ai-trading-dashboard under
# "administrator" — it reported MISSING instead of registering. That is the same defect as
# mt5_ensure_running.ps1 hardcoding the VPS repo root twice, and the only reason it was
# caught here instead of shipped is that this script checks its paths before registering.
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($cand in @("C:\Program Files\nodejs\node.exe", "C:\Program Files (x86)\nodejs\node.exe")) {
        if (Test-Path $cand) { $node = $cand; break }
    }
}
if (-not $node) { Write-Output "MISSING - node.exe not on PATH and not in Program Files"; exit 1 }
$account = "$env:USERDOMAIN\$env:USERNAME"
$log  = Join-Path $repo "tasks\logs\confluence.txt"

$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "EXISTS - '$name' is already registered (state: $($existing.State)). Not recreating."
    exit 0
}

foreach ($p in @($node, (Join-Path $repo "tasks\confluence.cjs"))) {
    if (-not (Test-Path $p)) { Write-Output "MISSING - $p"; exit 1 }
}
$logDir = Split-Path $log -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# utf8, not ascii: the table prints em-dashes and middots, and ascii turns them into
# mojibake that encoding_check.cjs then reports as corruption.
$inner = "& '$node' '$repo\tasks\confluence.cjs' --notify 2>&1 | Out-File -FilePath '$log' -Append -Encoding utf8"
$arg   = '-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"'

$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(4) `
                                    -RepetitionInterval (New-TimeSpan -Minutes 15)
# Limited matches every other SmartEntry task on this box. Highest would need elevation
# Windows refuses to grant to Set-ScheduledTask, and nothing here needs it.
$principal = New-ScheduledTaskPrincipal -UserId "User" -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                          -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description "Five-source confluence table (system, pre-open plan, daily plan, ATOMIC indicator, TradingView). Telegram only on a new full agreement, deduped per asset per direction per day. Read-only: places no order, moves no gate." | Out-Null

Write-Output "REGISTERED - '$name', every 15 minutes, --notify"
