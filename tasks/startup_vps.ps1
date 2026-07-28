# SmartEntry Pro — VPS Auto-Start
# Runs at Windows login on the VPS (C:\ai-trading-dashboard)
# Ensures server, bridges, and watchdog are all running.
# Also checks last trade date and logs everything.

$proj = 'C:\ai-trading-dashboard'
$log  = "$proj\tasks\logs\startup_vps_$(Get-Date -Format 'yyyyMMdd_HHmm').txt"

function Log($msg) {
    $ts = Get-Date -Format 'HH:mm:ss'
    "$ts  $msg" | Tee-Object -FilePath $log -Append
}

function TaskRunning($name) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    return ($t -and $t.State -eq 'Running')
}

function EnsureTask($name, $description) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) {
        Log "${description}: task '$name' NOT FOUND — create it in Task Scheduler"
        return
    }
    if ($t.State -eq 'Disabled') {
        Log "${description}: task '$name' is DISABLED — skipping"
        return
    }
    if ($t.State -ne 'Running') {
        Log "${description}: starting '$name'..."
        Start-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Start-Sleep 3
        $t2 = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($t2.State -eq 'Running') { Log "${description}: started OK" }
        else { Log "${description}: WARNING — may still be starting, check logs" }
    } else {
        Log "${description}: already running"
    }
}

New-Item -ItemType Directory -Force "$proj\tasks\logs" | Out-Null
Log "=== SmartEntry Pro VPS Auto-Start ==="
Log "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Log "Host: $env:COMPUTERNAME"

# ── 1. LOAD ENVIRONMENT (keys.env) ─────────────────────────────────────────────
$keysFile = "$proj\keys.env"
if (Test-Path $keysFile) {
    Get-Content $keysFile | ForEach-Object {
        if ($_ -match '^([^=]+)=(.+)$') { [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2]) }
    }
    Log "ENV: keys.env loaded"
} else {
    Log "ENV: WARNING — keys.env not found at $keysFile"
}

# ── 2. START NODE SERVER ──────────────────────────────────────────────────────
EnsureTask 'SmartEntryServer' 'SERVER'
Start-Sleep 5

# Verify server is actually responding
$serverOk = try { (Invoke-WebRequest 'http://localhost:3001/api/health' -TimeoutSec 8 -ErrorAction Stop).StatusCode -eq 200 } catch { $false }
if ($serverOk) { Log "SERVER: responding on port 3001 ✓" }
else { Log "SERVER: WARNING — port 3001 not responding after 5s — still starting?" }

# ── 3. START MT5 BRIDGES ─────────────────────────────────────────────────────
EnsureTask 'SmartEntryBridgeA' 'BRIDGE-A'
EnsureTask 'SmartEntryBridgeB' 'BRIDGE-B'

# ── 4. START WATCHDOG ────────────────────────────────────────────────────────
EnsureTask 'SmartEntryWatchdog' 'WATCHDOG'

# ── 5. CIRCUIT BREAKER + LAST TRADE CHECK ────────────────────────────────────
if ($serverOk) {
    try {
        $risk = Invoke-RestMethod 'http://localhost:3001/api/risk-status' -TimeoutSec 5
        if ($risk.halted) {
            Log "!!! CIRCUIT BREAKER: TRADING HALTED — reason: $($risk.haltReason) — run /diagnose"
        } else {
            Log "CIRCUIT BREAKER: clear | Regime: $($risk.regime) | Losses: $($risk.consecutiveLosses)"
        }
    } catch { Log "RISK: could not fetch" }

    try {
        $journal = Invoke-RestMethod 'http://localhost:3001/api/journal' -TimeoutSec 5
        if ($journal.trades -and $journal.trades.Count -gt 0) {
            $last = $journal.trades[0].timestamp -replace 'T.*',''
            $days = ((Get-Date) - [DateTime]$last).Days
            if ($days -ge 3) {
                Log "!!! NO TRADE IN $days DAYS (last: $last) — run /diagnose immediately"
            } else {
                Log "LAST TRADE: $last ($days days ago)"
            }
        } else {
            Log "JOURNAL: no trades on record"
        }
    } catch { Log "JOURNAL: could not fetch" }

    try {
        $signals = Invoke-RestMethod 'http://localhost:3001/api/signals' -TimeoutSec 5
        $btcConf  = $signals.btc.confidence
        $goldConf = $signals.gold.confidence
        $spxConf  = $signals.spx.confidence
        Log "SIGNALS: BTC=$btcConf% GOLD=$goldConf% SPX=$spxConf%"
        if ([int]$btcConf -ge 65 -or [int]$goldConf -ge 65 -or [int]$spxConf -ge 65) {
            Log "!!! SIGNAL READY — confidence ≥ 65% — check dashboard immediately"
        }
    } catch { Log "SIGNALS: could not fetch" }
}

Log "=== VPS Auto-Start Complete ==="
Log "Dashboard: http://localhost:3001/dashboard/index.html"
