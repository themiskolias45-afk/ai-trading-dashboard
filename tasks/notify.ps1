# Shared outbound notifier. Dot-source this; do not run it directly.
#
#     . (Join-Path $PSScriptRoot 'notify.ps1')
#     if (Test-NotifierConfigured) { Send-Notification 'text' }
#
# WHY IT EXISTS
# tasks/vps_monitor.ps1 is the external dead-man's switch: it runs on the LAPTOP so
# that a powered-off VPS still produces an alert. On 2026-08-07 it was found to have
# never sent a single message, and it never could -- the laptop's keys.env has no
# TELEGRAM_TOKEN at all. The switch was armed and mute, and nothing reported that,
# because "no alert arrived" looks exactly like "nothing went wrong".
#
# So the notifier is one function in one place, and -- more importantly --
# Test-NotifierConfigured exists so a health check can ask whether this box can raise
# an alarm AT ALL. Every other green check is worth very little if the answer is no.
#
# Portable: keys.env is resolved from this file's own location, so the same script
# serves C:\Users\User\ai-trading-dashboard and C:\ai-trading-dashboard.

function Get-NotifierKeysPath {
    $override = [Environment]::GetEnvironmentVariable('SMARTENTRY_KEYS_FILE')
    if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }
    return (Join-Path (Split-Path -Parent $PSScriptRoot) 'keys.env')
}

function Get-TelegramConfig {
    $keysFile = Get-NotifierKeysPath
    if (-not (Test-Path $keysFile)) { return $null }
    $lines = Get-Content $keysFile -ErrorAction SilentlyContinue
    $token = ($lines | Where-Object { $_ -like 'TELEGRAM_TOKEN=*' })   -replace '^TELEGRAM_TOKEN=', ''
    $chat  = ($lines | Where-Object { $_ -like 'TELEGRAM_CHAT_ID=*' }) -replace '^TELEGRAM_CHAT_ID=', ''
    if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($chat)) { return $null }
    return @{ Token = $token.Trim(); ChatId = $chat.Trim() }
}

# Can this box raise an alarm? Returns $true/$false and NEVER the credentials.
function Test-NotifierConfigured {
    return ($null -ne (Get-TelegramConfig))
}

# Why it cannot, in words safe to print in a log or a report. Never includes a value.
function Get-NotifierStatus {
    $keysFile = Get-NotifierKeysPath
    if (-not (Test-Path $keysFile)) { return "keys.env not found at $keysFile" }
    $cfg = Get-TelegramConfig
    if ($null -eq $cfg) { return 'keys.env has no TELEGRAM_TOKEN / TELEGRAM_CHAT_ID - this box cannot send alerts' }
    return 'telegram configured'
}

# Returns $true only when the message was actually accepted. A notifier that reports
# success on a failed send is worse than none, because it launders silence into
# confidence.
function Send-Notification($text) {
    $cfg = Get-TelegramConfig
    if ($null -eq $cfg) { return $false }
    try {
        $body = @{ chat_id = $cfg.ChatId; text = $text } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri ('https://api.telegram.org/bot' + $cfg.Token + '/sendMessage') `
            -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
        return $true
    } catch {
        return $false
    }
}
