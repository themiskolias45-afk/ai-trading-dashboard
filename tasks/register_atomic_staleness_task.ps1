# Registers "SmartEntry Atomic Staleness Watch" - the job that runs tasks\atomic_staleness_watch.cjs.
#
# WHY THIS EXISTS. On 2026-09-08 the ATOMIC indicator was attached to BTCUSD, SP500 and
# XAUUSD on the laptop. At 14:32 local the charts reloaded and it came back on TWO of the
# three - SP500 was silently dropped. Its file then sat unchanged for 112 minutes while
# the other two updated every 60 seconds, and nothing said a word. The feed task kept
# exiting 0 the whole time, because it was shipping the file it found; the file was just
# old. This watches for the failure that LOOKS like success.
#
# IT IS READ-ONLY. Reads the indicator's own output files, writes its own state, sends one
# Telegram. Places no order, moves no gate, clears no halt, and never removes a roster
# entry - a symbol that stops appearing is the loudest case, not a reason to forget it.
#
# SPAM IS BOUNDED BY THE RISING EDGE. It alerts when a symbol STARTS stalling and once
# more when it recovers, not every run while it stays stale. State advances only after a
# confirmed send, so a refused Telegram leaves the stall still unreported.
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

$name = "SmartEntry Atomic Staleness Watch"

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
$log = Join-Path $repo "tasks\logs\atomic_staleness_watch.txt"

$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing -and -not $Update) {
    Write-Output "EXISTS - '$name' is already registered (state: $($existing.State)). Not recreating."
    Write-Output "         Pass -Update to rewrite its action in place (Set-ScheduledTask, never a delete)."
    exit 0
}

# VERIFY BEFORE ACTING. This is the whole difference between this file and the ones that
# reported success while doing nothing.
foreach ($p in @($node, (Join-Path $repo "tasks\atomic_staleness_watch.cjs"))) {
    if (-not (Test-Path $p)) { Write-Output "MISSING - $p"; exit 1 }
}
$logDir = Split-Path $log -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# TWO separate encoding settings, and BOTH are needed. node emits UTF-8; PowerShell decodes
# a native command's output with [Console]::OutputEncoding (the OEM codepage) BEFORE
# Out-File sees it, so -Encoding utf8 alone still writes mojibake.
$inner = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
         "& '$node' '$repo\tasks\atomic_staleness_watch.cjs' --notify 2>&1 | Out-File -FilePath '$log' -Append -Encoding utf8"
$arg = '-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"'

$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(9) `
                                    -RepetitionInterval (New-TimeSpan -Minutes 15)
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
    -Description "Alerts when an ATOMIC_ANALYST_V84 symbol stops being written - a chart the indicator was dropped from looks identical to a healthy one, because the feed task exits 0 either way. Rising edge only. Read-only: places no order, moves no gate, clears no halt." | Out-Null

Write-Output "REGISTERED - '$name', every 15 minutes, --notify"
Write-Output "  repo    $repo"
Write-Output "  node    $node"
Write-Output "  account $account"
