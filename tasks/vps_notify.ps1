# ---------------------------------------------------------------------------
# VPS self-reporting. RUNS ON THE VPS.
#
# The problem this solves: the only external alarm lived on the local PC, so if
# that PC was off - which is the entire reason a VPS exists - nothing was watching.
# A box cannot report its own death, but it can do the next best thing:
#
#   -Mode boot       announce every startup, so an unexpected reboot is never silent
#   -Mode heartbeat  say "all normal" once a day
#
# The heartbeat is the dead-man's switch. Its ABSENCE is the alarm: if the daily
# message does not arrive, something is wrong and no PC had to be awake to notice.
# This needs nothing but Telegram, which is already configured and verified.
#
# Boot mode waits for the stack to actually come up before reporting, so it tells
# you what recovered rather than what merely got triggered.
# ---------------------------------------------------------------------------

param(
    [ValidateSet('boot', 'heartbeat')]
    [string]$Mode = 'heartbeat'
)

$ErrorActionPreference = 'Continue'

$root      = 'C:\ai-trading-dashboard'
$keysFile  = Join-Path $root 'keys.env'
$logFile   = Join-Path $root 'tasks\logs\vps_notify.txt'
$healerUrl = 'http://localhost:3001/api/healer'

# A cold boot has to launch MT5 and let the bridge finish its connect retries
# before any of this means anything. Poll rather than guess a fixed sleep.
$BOOT_WAIT_MAX_SECONDS  = 300
$BOOT_POLL_INTERVAL_SEC = 15

$logDir = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-NotifyLog($message) {
    Add-Content -Path $logFile -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message) -ErrorAction SilentlyContinue
}

function Send-Telegram($text) {
    if (-not (Test-Path $keysFile)) { Write-NotifyLog 'NOT SENT - keys.env missing'; return }
    $lines = Get-Content $keysFile -ErrorAction SilentlyContinue
    $token = (($lines | Where-Object { $_ -like 'TELEGRAM_TOKEN=*' }) -replace '^TELEGRAM_TOKEN=', '').Trim()
    $chat  = (($lines | Where-Object { $_ -like 'TELEGRAM_CHAT_ID=*' }) -replace '^TELEGRAM_CHAT_ID=', '').Trim()
    if (-not $token -or -not $chat) { Write-NotifyLog 'NOT SENT - token or chat id empty'; return }
    try {
        $payload = @{ chat_id = $chat; text = $text } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri ('https://api.telegram.org/bot' + $token + '/sendMessage') `
            -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 25 | Out-Null
        Write-NotifyLog ('sent (' + $Mode + ')')
    } catch {
        Write-NotifyLog ('SEND FAILED - ' + $_.Exception.Message)
    }
}

function Get-StackStatus {
    $status = @{ Problems = @(); Lines = @() }

    foreach ($name in 'SmartEntryServer', 'SmartEntryBridgeA', 'SmartEntryBridgeB', 'SmartEntryWatchdog', 'SmartEntryBackup') {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) {
            $status.Problems += ($name + ' MISSING')
            $status.Lines += ($name + ': MISSING')
            continue
        }
        $state = [string]$task.State
        $status.Lines += ($name + ': ' + $state)
        # Disabled is an operator decision, not a fault - Bridge B is deliberately
        # off while the VPS has only one broker account.
        if ($state -ne 'Running' -and $state -ne 'Ready' -and $state -ne 'Disabled') {
            $status.Problems += ($name + ' is ' + $state)
        }
    }

    try {
        $healer = Invoke-RestMethod -Uri $healerUrl -TimeoutSec 15
        if ($healer.healthy -eq $true) {
            $status.Lines += 'Healer: healthy'
        } else {
            $status.Lines += 'Healer: UNHEALTHY'
            $status.Problems += 'healer reports unhealthy'
        }
        if ($healer.checks -and $healer.checks.mt5Bridge) {
            $status.Lines += ('Bridges: ' + $healer.checks.mt5Bridge.detail)
            if ($healer.checks.mt5Bridge.ok -ne $true) { $status.Problems += 'bridge check failing' }
        }
    } catch {
        $status.Lines += 'Healer: NOT RESPONDING'
        $status.Problems += 'server not responding on localhost:3001'
    }

    try {
        $drive   = Get-PSDrive C -ErrorAction Stop
        $freeGB  = [math]::Round($drive.Free / 1GB, 1)
        $status.Lines += ('Disk free: ' + $freeGB + ' GB')
        if ($freeGB -lt 5) { $status.Problems += ('disk low: ' + $freeGB + ' GB free') }
    } catch { }

    return $status
}

# --- boot: wait for the stack, then report what actually came back ----------
if ($Mode -eq 'boot') {
    $waited = 0
    while ($waited -lt $BOOT_WAIT_MAX_SECONDS) {
        try {
            $probe = Invoke-RestMethod -Uri $healerUrl -TimeoutSec 10
            if ($probe) { break }
        } catch { }
        Start-Sleep -Seconds $BOOT_POLL_INTERVAL_SEC
        $waited += $BOOT_POLL_INTERVAL_SEC
    }

    $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    $status   = Get-StackStatus

    if ($status.Problems.Count -eq 0) {
        $msg = "SmartEntry VPS RESTARTED - recovered OK`n`n"
        $msg += "Booted: $bootTime`n"
        $msg += "Came back on its own after " + $waited + "s.`n`n"
    } else {
        $msg = "SmartEntry VPS RESTARTED - NEEDS ATTENTION`n`n"
        $msg += "Booted: $bootTime`n`n"
        $msg += "Problems:`n  - " + ($status.Problems -join "`n  - ") + "`n`n"
    }
    $msg += ($status.Lines -join "`n")
    Send-Telegram $msg
    exit 0
}

# --- heartbeat: daily proof of life ----------------------------------------
$status = Get-StackStatus
$uptime = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime

if ($status.Problems.Count -eq 0) {
    $msg = "SmartEntry VPS daily check - all normal`n`n"
} else {
    $msg = "SmartEntry VPS daily check - PROBLEMS FOUND`n`n"
    $msg += "  - " + ($status.Problems -join "`n  - ") + "`n`n"
}
$msg += ($status.Lines -join "`n")
$msg += "`n`nUptime: " + [math]::Floor($uptime.TotalDays) + "d " + $uptime.Hours + "h " + $uptime.Minutes + "m"
$msg += "`n`nIf this message ever stops arriving, the VPS is down."
Send-Telegram $msg
