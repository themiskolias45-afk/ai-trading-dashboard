# ---------------------------------------------------------------------------
# External dead-man's switch for the Contabo VPS.
#
# RUNS ON THE LOCAL MACHINE. That is the entire point. Every other piece of
# monitoring in this system lives inside the VPS: the auto-healer runs in the node
# process, so a dead server sends no alert, and watchdog_vps.bat runs as a VPS
# Scheduled Task, so a powered-off or unreachable box triggers nothing at all.
# Silence was indistinguishable from health - the outage you would notice by
# missing a signal, not by being told.
#
# This talks to the Telegram API directly from this machine, so it does not depend
# on any part of the VPS being alive to deliver bad news.
#
# Alerts on the TRANSITION into trouble and again on recovery - never every run.
# A 5-minute task that re-sends the same alarm becomes noise you learn to ignore,
# which is the same as having no alarm.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'

# Overridable so the alarm can be rehearsed against a dead endpoint without
# touching the real VPS and without firing a live Telegram alert at anyone. An
# untested alarm is an assumption, not a safety net. Production values are the
# defaults; the Scheduled Task sets nothing.
function Get-Setting($envName, $default) {
    $value = [Environment]::GetEnvironmentVariable($envName)
    if ([string]::IsNullOrWhiteSpace($value)) { return $default }
    return $value
}

$vpsUrl    = Get-Setting 'VPS_MONITOR_URL'   'http://169.58.74.133:3001/api/healer'
$keysFile  = Get-Setting 'VPS_MONITOR_KEYS'  'C:\Users\User\ai-trading-dashboard\keys.env'
$stateFile = Get-Setting 'VPS_MONITOR_STATE' 'C:\Users\User\ai-trading-dashboard\tasks\logs\vps_monitor_state.json'
$logFile   = Get-Setting 'VPS_MONITOR_LOG'   'C:\Users\User\ai-trading-dashboard\tasks\logs\vps_monitor.txt'

# One transient failure is a network blip, not an outage. Two consecutive misses at
# a 5-minute cadence means ~10 minutes genuinely unreachable.
$FAILURES_BEFORE_ALERT = 2
$REQUEST_TIMEOUT_SEC   = 15

$logDir = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-MonitorLog($message) {
    Add-Content -Path $logFile -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message) -ErrorAction SilentlyContinue
}

function Get-TelegramConfig {
    if (-not (Test-Path $keysFile)) { return $null }
    $lines = Get-Content $keysFile -ErrorAction SilentlyContinue
    $token = ($lines | Where-Object { $_ -like 'TELEGRAM_TOKEN=*' }) -replace '^TELEGRAM_TOKEN=', ''
    $chat  = ($lines | Where-Object { $_ -like 'TELEGRAM_CHAT_ID=*' }) -replace '^TELEGRAM_CHAT_ID=', ''
    if (-not $token -or -not $chat) { return $null }
    return @{ Token = $token.Trim(); ChatId = $chat.Trim() }
}

function Send-Alert($text) {
    $cfg = Get-TelegramConfig
    if (-not $cfg) { Write-MonitorLog 'ALERT NOT SENT - no Telegram token/chat id in keys.env'; return }
    try {
        $body = @{ chat_id = $cfg.ChatId; text = $text } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri ('https://api.telegram.org/bot' + $cfg.Token + '/sendMessage') `
            -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
        Write-MonitorLog 'Telegram alert sent'
    } catch {
        Write-MonitorLog ('Telegram send FAILED - ' + $_.Exception.Message)
    }
}

# --- previous state -------------------------------------------------------
$consecutiveFailures = 0
$lastState = 'ok'
if (Test-Path $stateFile) {
    try {
        $prev = Get-Content $stateFile -Raw | ConvertFrom-Json
        if ($null -ne $prev.consecutiveFailures) { $consecutiveFailures = [int]$prev.consecutiveFailures }
        if ($prev.lastState) { $lastState = [string]$prev.lastState }
    } catch {
        # Corrupt state file must not stop the check - a monitor that dies on its
        # own bookkeeping is worse than no monitor.
        Write-MonitorLog 'State file unreadable - treating as first run'
    }
}

# --- probe ----------------------------------------------------------------
$reachable = $false
$problems  = @()

try {
    $response = Invoke-RestMethod -Uri $vpsUrl -TimeoutSec $REQUEST_TIMEOUT_SEC
    $reachable = $true

    if ($response.healthy -ne $true) { $problems += 'healer reports unhealthy' }

    # Name the specific failing check - "unhealthy" alone sends you hunting.
    if ($response.checks) {
        foreach ($name in $response.checks.PSObject.Properties.Name) {
            $check = $response.checks.$name
            if ($check.ok -ne $true) { $problems += ($name + ': ' + $check.detail) }
        }
    }
} catch {
    $problems += ('unreachable - ' + $_.Exception.Message)
}

# --- decide ---------------------------------------------------------------
if ($reachable -and $problems.Count -eq 0) {
    if ($lastState -eq 'down') {
        Send-Alert ("SmartEntry VPS RECOVERED`n`nThe VPS is reachable again and all healer checks are green.")
        Write-MonitorLog 'RECOVERED - alert sent'
    }
    $consecutiveFailures = 0
    $lastState = 'ok'
} else {
    $consecutiveFailures = $consecutiveFailures + 1
    $detail = ($problems -join "`n  - ")
    Write-MonitorLog ('problem (' + $consecutiveFailures + '/' + $FAILURES_BEFORE_ALERT + '): ' + $detail)

    if ($consecutiveFailures -ge $FAILURES_BEFORE_ALERT -and $lastState -ne 'down') {
        $msg = "SmartEntry VPS PROBLEM`n`n"
        if (-not $reachable) {
            $msg += "The VPS did not respond to $consecutiveFailures consecutive checks.`n`n"
            $msg += "No trades will execute and no signals will fire until it is back. "
            $msg += "Check the Contabo panel - if the box rebooted and Windows auto-logon failed, "
            $msg += "nothing starts on its own.`n`n"
        } else {
            $msg += "The VPS is up but reporting faults:`n  - $detail`n`n"
        }
        $msg += "Checked: $vpsUrl"
        Send-Alert $msg
        $lastState = 'down'
    }
}

# --- report THIS box as alive, while we are already talking to the VPS ------
#
# The watching is one-directional and always was: this script exists so a dead VPS
# raises an alarm, and nothing at all notices a dead LAPTOP. If this machine sleeps
# or is shut, Bridge A on account 25446287 stops trading and the absence of trades
# looks exactly like a quiet market.
#
# The laptop cannot be reached from outside, so the direction has to be push. This
# runs every 5 minutes and is already in conversation with the VPS, so it is the
# natural place. Best-effort by design: failing to report in must never affect the
# VPS alarm above, which is the more important job.
try {
    $relaySecret = $null
    if (Test-Path $keysFile) {
        $relaySecret = (((Get-Content $keysFile -ErrorAction SilentlyContinue) |
            Where-Object { $_ -like 'AGENT_RELAY_SECRET=*' }) -replace '^AGENT_RELAY_SECRET=', '').Trim()
    }
    if ($relaySecret) {
        $peerUrl = ($vpsUrl -replace '/api/healer$', '/api/peer-heartbeat')

        # WHAT this box is running, not just that it is. The VPS cannot pull from
        # here - this machine is not addressable from outside - so the check-in is
        # the only way the always-on box can ever learn that its partner is gating
        # trades differently, has an open breaker, or has a silent bridge.
        #
        # Best-effort in its own try: a local server that is down must still produce
        # a heartbeat, because "alive but cannot describe itself" is information and
        # silence is not. All endpoints below are public GETs, so no session needed.
        $selfState = $null
        try {
            $local     = Get-Setting 'VPS_MONITOR_SELF_URL' 'http://localhost:3001'
            $settings  = Invoke-RestMethod -Uri "$local/api/strategy-settings" -TimeoutSec 5
            $risk      = Invoke-RestMethod -Uri "$local/api/risk-status"       -TimeoutSec 5
            $armed = @(); $live = @(); $silent = @()
            foreach ($tag in $risk.accounts.PSObject.Properties.Name) {
                if ($risk.accounts.$tag.config.autoMode) { $armed += $tag }
                try {
                    $health = Invoke-RestMethod -Uri "$local/api/mt5/health?account=$tag" -TimeoutSec 5
                    if ($health.connected) { $live += $tag } else { $silent += $tag }
                } catch { $silent += $tag }
            }
            $unreviewed = $null
            try { $unreviewed = (Invoke-RestMethod -Uri "$local/api/ai-work" -TimeoutSec 5).totals.unreviewed } catch { }
            $selfState = @{
                gate                = $settings.confidenceThreshold
                settingsError       = $settings.settingsError
                halted              = [bool]$risk.halted
                haltReason          = [string]$risk.haltReason
                dailyPnl            = $risk.dailyPnl
                armed               = $armed
                bridgesLive         = $live
                bridgesSilent       = $silent
                unreviewedProposals = $unreviewed
            }
        } catch {
            Write-MonitorLog ('self-state not gathered - ' + $_.Exception.Message)
        }

        $payload = @{
            secret = $relaySecret
            box    = $env:COMPUTERNAME
            status = $(if ($reachable -and $problems.Count -eq 0) { 'ok' } else { 'degraded' })
            detail = $(if ($problems.Count) { ($problems -join '; ') } else { 'laptop monitor reporting in' })
            state  = $selfState
        } | ConvertTo-Json -Compress -Depth 4
        Invoke-RestMethod -Uri $peerUrl -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 10 | Out-Null
    } else {
        Write-MonitorLog 'peer heartbeat skipped - no AGENT_RELAY_SECRET in keys.env'
    }
} catch {
    Write-MonitorLog ('peer heartbeat not delivered - ' + $_.Exception.Message)
}

# --- persist --------------------------------------------------------------
$state = @{
    consecutiveFailures = $consecutiveFailures
    lastState           = $lastState
    lastCheckedAt       = (Get-Date -Format 'o')
}
try {
    $state | ConvertTo-Json | Set-Content -Path $stateFile -Encoding utf8
} catch {
    Write-MonitorLog ('Could not write state file - ' + $_.Exception.Message)
}
