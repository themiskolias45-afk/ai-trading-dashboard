# Draw today's plan on the TradingView charts, unattended.
#
#   powershell -File tasks\tv_daily_plan.ps1 [-DryRun]
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# WHY THIS EXISTS
# tradingview_bot.py reads /api/signals LIVE, so the levels it draws are never stale
# by design. It was still showing days-old entries, because nothing ran it: no
# scheduled task on either box invoked it, so the chart held whatever a human last
# drew by hand. Gold looked frozen for exactly that reason - the engine was fine and
# the drawer was never called.
#
# It also cannot simply be scheduled as-is. The bot does not start a browser; it
# ATTACHES to one over CDP 9222 (make_context -> connect_over_cdp) using the logged-in
# TradingView session in the dedicated Edge profile. No browser, no draw. So the job
# has to guarantee its own precondition rather than assume it.
#
# FAILURE MODE IS "REFUSE", NOT "DRAW ANYWAY".
# If the SmartEntry server is not answering, this exits without drawing. Levels put on
# a live chart from a dead engine are worse than no levels: they look current, they are
# not, and nothing on the chart says which. The same reasoning as the bridge's
# STALE_SOURCE gate.
#
# EVERY RUN WRITES A VERDICT, and the doctor reads the PER-RUN file rather than the
# history. A cumulative log can only ever say the job succeeded SOMETIME, which is the
# same mistake as a marker written where nobody reads it.

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

$proj      = Split-Path -Parent $PSScriptRoot
$log       = Join-Path $proj 'tasks\logs\tv_daily_plan.txt'
$lastFile  = Join-Path $proj 'tasks\logs\tv_daily_plan_last.txt'
$launcher  = Join-Path $proj 'tasks\launch_chrome_tv.bat'
$bot       = Join-Path $proj 'tradingview_bot.py'

# The engine must be answering before anything is drawn from it.
$serverUrl = 'http://localhost:3001/api/status'
# The bot attaches here; this is the port launch_chrome_tv.bat opens.
$cdpUrl    = 'http://localhost:9222/json/version'
# Edge needs a moment after launch, and a cold profile is slower than a warm one.
$browserWaitSeconds = 30
$probeTimeoutSec    = 5
# The bot switches symbol and screenshots three charts; it is not fast.
$botTimeoutSeconds  = 600

$transcript = New-Object System.Collections.Generic.List[string]

function Say($msg) {
    $line = "[" + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + "] $msg"
    Write-Host $line
    $script:transcript.Add($line)
    Add-Content -Path $log -Value $line -Encoding utf8
}

# The per-run file the doctor reads. Written on EVERY exit path including the failures,
# because a run that died without recording anything is indistinguishable from a run
# that never started.
function Finish($code, $verdict) {
    $script:transcript.Add("[tv-plan exit $code] $verdict")
    Set-Content -Path $lastFile -Value ($script:transcript -join "`r`n") -Encoding utf8
    exit $code
}

function Probe($url) {
    try {
        Invoke-WebRequest -Uri $url -TimeoutSec $probeTimeoutSec -UseBasicParsing | Out-Null
        return $true
    } catch { return $false }
}

Say '--- tv daily plan start ---'

if (-not (Test-Path $bot)) {
    Say "REFUSED: $bot not found."
    Finish 2 'bot script missing'
}

# 1. The engine. Refuse rather than draw yesterday's numbers onto a live chart.
if (-not (Probe $serverUrl)) {
    Say 'REFUSED: SmartEntry server is not answering on :3001 - not drawing.'
    Say '         Levels drawn from a dead engine look current and are not.'
    Finish 2 'server down - refused, nothing drawn'
}
Say 'server: up'

# 2. The browser. Probe first: launching unconditionally would stack a second Edge on
# top of a working one, and two browsers on one CDP port is its own failure.
if (Probe $cdpUrl) {
    Say 'browser: already on CDP 9222'
} elseif ($DryRun) {
    Say 'browser: absent (dry run - not launching)'
    Finish 0 'dry run - would have launched Edge and drawn'
} else {
    Say 'browser: absent - launching Edge on the SmartEntryTV profile'
    if (-not (Test-Path $launcher)) {
        Say "REFUSED: $launcher not found."
        Finish 3 'browser launcher missing'
    }
    Start-Process -FilePath $launcher -WindowStyle Minimized | Out-Null

    $deadline = (Get-Date).AddSeconds($browserWaitSeconds)
    while ((Get-Date) -lt $deadline -and -not (Probe $cdpUrl)) {
        Start-Sleep -Seconds 2
    }
    if (-not (Probe $cdpUrl)) {
        Say "REFUSED: CDP 9222 did not open within $browserWaitSeconds s."
        Say '         Edge may need a TradingView login once by hand in that profile.'
        Finish 3 'browser did not come up'
    }
    Say 'browser: up'
}

if ($DryRun) {
    Say 'dry run - stopping before the draw.'
    Finish 0 'dry run - preconditions met'
}

# 3. Draw. cmd_plan returns non-zero if any symbol failed, so a run that silently
# stops working is visible instead of looking like a clean pass.
Say 'drawing: python tradingview_bot.py plan'
$out = Join-Path $env:TEMP ("tv_plan_out_" + [guid]::NewGuid().ToString('N') + '.txt')
try {
    $p = Start-Process -FilePath 'python' -ArgumentList @($bot, 'plan') `
            -WorkingDirectory $proj -NoNewWindow -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError "$out.err"
    # Touching .Handle caches the native handle on the object. Without this,
    # Start-Process -PassThru lets the handle go and ExitCode reads back EMPTY once the
    # process has ended - which reported a run that drew all three charts as a failure.
    # It must happen BEFORE the wait, while the process is still alive.
    $null = $p.Handle
    if (-not $p.WaitForExit($botTimeoutSeconds * 1000)) {
        try { $p.Kill() } catch {}
        Say "FAILED: the bot did not finish within $botTimeoutSeconds s - killed."
        Finish 4 'bot timed out'
    }
    # The TIMED WaitForExit overload returns as soon as the process ends but does not
    # populate ExitCode on the object Start-Process -PassThru handed back. Reading it
    # here gave an empty string, so a run that drew all three charts correctly was
    # reported as "exited " and failed the job. The parameterless call flushes it and
    # returns immediately, the process having already gone.
    $p.WaitForExit()
    $code = $p.ExitCode
    foreach ($file in @($out, "$out.err")) {
        if (Test-Path $file) {
            Get-Content $file | Where-Object { $_ -and $_.Trim() } |
                ForEach-Object { Say ("  | " + $_) }
        }
    }
} finally {
    foreach ($file in @($out, "$out.err")) {
        if (Test-Path $file) { Remove-Item $file -Force -ErrorAction SilentlyContinue }
    }
}

# An absent exit code is NOT a pass. It means this script could not read the result,
# which is a different fault from the bot failing and must not be rounded to either.
if ($null -eq $code) {
    Say 'FAILED: could not read the bot exit code - result unknown, not assumed good.'
    Finish 6 'exit code unreadable'
}
if ($code -ne 0) {
    Say "FAILED: tradingview_bot.py plan exited $code"
    Finish 5 "bot exited $code"
}

Say 'OK: plan drawn on all charts'
Finish 0 'plan drawn'
