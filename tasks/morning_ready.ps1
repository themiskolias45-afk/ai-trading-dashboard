# SmartEntry Pro -- morning readiness.
#
# WHY THIS EXISTS
# The user's standing instruction, 2026-08-24: "as soon as I open the laptop next time
# it needs to be done." Everything that was outstanding at the end of that session was
# a thing a human had to remember to run. This runs it instead, on the same trigger
# model that already works for the gap filler: LOGON + UNLOCK, not logon alone. Opening
# a laptop lid is a resume and an unlock; a logon-only trigger never fires and the work
# silently does not happen -- see tasks\ensure_running.ps1 for the 18-day version of
# that story.
#
# WHAT IT DOES, in order, once per day:
#   1. fills any gaps in the running stack (delegates to ensure_running.ps1, which
#      never kills anything and is safe to repeat)
#   2. draws today's TradingView plan if the scheduled run has not already succeeded
#   3. REPOINTS the plan studies, because TradingView pins a study to the script
#      version it was added at and will not recompile it on a save
#   4. re-runs the daily check ONLY if its last result was a failure
#   5. runs the coverage audit and reports the RED count
#   6. sends ONE Telegram summary -- outbound was verified working 2026-08-24
#
# It is SAFE TO RUN AT ANY TIME. Every step is either a no-op when already done, or
# idempotent. It never kills a process, never deletes a file, and never touches
# learning data, the journal or strategy settings.

$ErrorActionPreference = 'Continue'
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

$logDir = Join-Path $proj 'tasks\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$log = Join-Path $logDir 'morning_ready.txt'

function Say([string]$text) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $text
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

# ---- once per day -----------------------------------------------------------
# A flag FILE, not a registry value or an in-memory guard: the unlock trigger can
# fire many times a day and each one starts a fresh process that remembers nothing.
$stamp = Get-Date -Format 'yyyyMMdd'
$flag  = Join-Path $proj ("tasks\.morning_ready_" + $stamp)
if ((Test-Path $flag) -and -not $env:JARVIS_FORCE_MORNING) {
  Write-Host "morning readiness already ran today ($stamp) -- nothing to do"
  exit 0
}

Say '=== MORNING READINESS START ==='
$results = [System.Collections.ArrayList]@()
function Note([string]$k, [string]$v) { $results.Add("$k`: $v") | Out-Null; Say "  $k -> $v" }

# ---- 1. fill gaps in the stack ---------------------------------------------
$ensure = Join-Path $proj 'tasks\ensure_running.ps1'
if (Test-Path $ensure) {
  Say 'step 1: ensure_running (gap filler, never kills)'
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ensure *>&1 |
      Select-Object -Last 3 | ForEach-Object { Say ("   | " + $_) }
    Note 'stack' 'checked'
  } catch { Note 'stack' ('ERROR ' + $_.Exception.Message) }
} else {
  Note 'stack' 'ensure_running.ps1 ABSENT'
}

# ---- 2. is the server actually answering? ----------------------------------
$serverUp = $false
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3001/api/status' -TimeoutSec 8 -UseBasicParsing
  $serverUp = ($r.StatusCode -eq 200)
} catch { $serverUp = $false }
Note 'server' $(if ($serverUp) { 'up' } else { 'DOWN' })

if (-not $serverUp) {
  Say 'server is down after the gap filler -- stopping before the browser steps'
  Note 'verdict' 'BLOCKED - server down'
} else {

  # ---- 3. today's TradingView plan ------------------------------------------
  # Skip if the scheduled 06:45 run already succeeded today: no point redrawing.
  $tvOk = $false
  $tvTask = Get-ScheduledTask -TaskName 'SmartEntry TV Daily Plan' -ErrorAction SilentlyContinue
  if ($tvTask) {
    $inf = $tvTask | Get-ScheduledTaskInfo
    if ($inf.LastTaskResult -eq 0 -and $inf.LastRunTime -and
        $inf.LastRunTime.Date -eq (Get-Date).Date) {
      $tvOk = $true
      Note 'tv plan' ('already OK today at ' + $inf.LastRunTime.ToString('HH:mm'))
    }
  }
  if (-not $tvOk) {
    Say 'step 3: drawing today TradingView plan'
    $tvScript = Join-Path $proj 'tasks\tv_daily_plan.ps1'
    if (Test-Path $tvScript) {
      try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tvScript *>&1 |
          Select-Object -Last 4 | ForEach-Object { Say ("   | " + $_) }
        $tvOk = ($LASTEXITCODE -eq 0)
      } catch { Say ('   tv plan threw: ' + $_.Exception.Message) }
    }
    Note 'tv plan' $(if ($tvOk) { 'drawn' } else { 'FAILED' })
  }

  # ---- 4. repoint the pinned studies ----------------------------------------
  # TradingView does NOT recompile a study already on a chart when its source script
  # is re-saved, so a correct save can still leave an OLD panel on screen. This is the
  # step that was missing for weeks. Only worth attempting if the plan itself drew.
  if ($tvOk) {
    Say 'step 4: repointing plan studies against the current script'
    try {
      & python.exe (Join-Path $proj 'tradingview_bot.py') repoint *>&1 |
        Select-Object -Last 5 | ForEach-Object { Say ("   | " + $_) }
      Note 'repoint' $(if ($LASTEXITCODE -eq 0) { 'all charts current' } else { 'FAILED' })
    } catch { Note 'repoint' ('ERROR ' + $_.Exception.Message) }
  } else {
    Note 'repoint' 'skipped - no plan to point at'
  }

  # ---- 5. daily check, only if it last FAILED -------------------------------
  # Re-running a heavy agent job that already succeeded burns API credit for nothing,
  # and the user watches that spend. Only retry a genuine failure.
  $dcTask = Get-ScheduledTask -TaskName 'SmartEntry - Daily Check' -ErrorAction SilentlyContinue
  if ($dcTask) {
    $inf = $dcTask | Get-ScheduledTaskInfo
    $ranToday = ($inf.LastRunTime -and $inf.LastRunTime.Date -eq (Get-Date).Date)
    if ($inf.LastTaskResult -eq 0 -and $ranToday) {
      Note 'daily check' 'already OK today'
    } elseif ($dcTask.State -eq 'Running') {
      Note 'daily check' 'already running'
    } else {
      Say 'step 5: re-running the daily check (last result was a failure)'
      try {
        Start-ScheduledTask -TaskName 'SmartEntry - Daily Check'
        Note 'daily check' 'restarted'
      } catch { Note 'daily check' ('could not start: ' + $_.Exception.Message) }
    }
  } else {
    Note 'daily check' 'task not registered'
  }
}

# ---- 6. coverage audit ------------------------------------------------------
$redLine = ''
$audit = Join-Path $proj 'tasks\coverage_audit.ps1'
if (Test-Path $audit) {
  Say 'step 6: coverage audit'
  try {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $audit *>&1
    $summary = $out | Where-Object { $_ -match 'checks:' } | Select-Object -Last 1
    $redLine = ($out | Where-Object { $_ -match '^\s*RED\s*:' } | Select-Object -Last 1)
    if ($summary) { Note 'audit' ($summary.ToString().Trim()) }
    if ($redLine) { Say ('   ' + $redLine.ToString().Trim()) }
  } catch { Note 'audit' ('ERROR ' + $_.Exception.Message) }
}

# ---- 7. one Telegram summary ------------------------------------------------
# Outbound was verified delivering on 2026-08-24. Inbound is permanently 409 while a
# Supabase webhook is registered on the bot, so this is one-way BY DESIGN.
# notifications.py does NOT send to Telegram -- it is toast + webhook only. The
# shared outbound notifier is tasks\notify.ps1, and Test-NotifierConfigured exists
# precisely so a box that CANNOT raise an alarm says so instead of going quietly mute.
try {
  . (Join-Path $PSScriptRoot 'notify.ps1')
  if (Test-NotifierConfigured) {
    $body = "JARVIS morning readiness " + (Get-Date -Format 'yyyy-MM-dd HH:mm') + "`n" +
            ($results -join "`n")
    if ($redLine) { $body = $body + "`n" + $redLine.ToString().Trim() }
    Send-Notification $body
    Say 'telegram summary sent'
  } else {
    Say 'telegram NOT configured on this box - no summary sent'
  }
} catch { Say ('telegram summary failed: ' + $_.Exception.Message) }

# Flag LAST: if the run dies half way, the next unlock retries instead of assuming
# the work was done.
Set-Content -Path $flag -Value (Get-Date -Format o) -Encoding utf8
Say '=== MORNING READINESS DONE ==='
exit 0
