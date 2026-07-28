# SmartEntry Pro -- Full Auto-Start
# Run this once at Windows startup (add to Task Scheduler or Windows startup folder)
# Starts: server, MT5 bridge, daily AI check, watchdog

$proj = 'C:\Users\User\ai-trading-dashboard'
$log  = "$proj\tasks\logs\startup_all_$(Get-Date -Format 'yyyyMMdd_HHmm').txt"

function Log($msg) {
    $ts = Get-Date -Format 'HH:mm:ss'
    "$ts  $msg" | Tee-Object -FilePath $log -Append
}

Set-Location $proj

# 1. CREATE LOG DIR
New-Item -ItemType Directory -Force "$proj\tasks\logs" | Out-Null
Log "=== SmartEntry Pro Auto-Start ==="
Log "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"

# 2. START NODE SERVER
$serverRunning = try { (Invoke-WebRequest -Uri 'http://localhost:3001/api/health' -TimeoutSec 3 -ErrorAction Stop).StatusCode -eq 200 } catch { $false }
if ($serverRunning) {
    Log "SERVER: already running on port 3001"
} else {
    Log "SERVER: starting..."
    Start-Process -FilePath 'node' `
        -ArgumentList 'server/index.js' `
        -WorkingDirectory $proj `
        -RedirectStandardOutput "$proj\tasks\logs\server_log.txt" `
        -RedirectStandardError  "$proj\tasks\logs\server_err.txt" `
        -NoNewWindow
    Start-Sleep 3
    $check = try { (Invoke-WebRequest -Uri 'http://localhost:3001/api/health' -TimeoutSec 5 -ErrorAction Stop).StatusCode -eq 200 } catch { $false }
    if ($check) { Log "SERVER: started OK" } else { Log "SERVER: FAILED TO START -- check tasks\logs\server_err.txt" }
}

# 3. START MT5 BRIDGE (auto mode)
$bridgeRunning = Get-Process -Name 'python' -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*mt5_bridge*' }
if ($bridgeRunning) {
    Log "MT5 BRIDGE: already running"
} else {
    Log "MT5 BRIDGE: starting in auto mode..."
    Start-Process -FilePath 'python' `
        -ArgumentList 'mt5_bridge.py --auto' `
        -WorkingDirectory $proj `
        -RedirectStandardOutput "$proj\tasks\logs\bridge_log.txt" `
        -RedirectStandardError  "$proj\tasks\logs\bridge_err.txt" `
        -NoNewWindow
    Start-Sleep 2
    Log "MT5 BRIDGE: started"
}

# 4. CHECK CIRCUIT BREAKER
try {
    $risk = Invoke-RestMethod -Uri 'http://localhost:3001/api/risk-status' -TimeoutSec 5
    if ($risk.halted -or $risk.circuitBreaker) {
        Log "CIRCUIT BREAKER: !!! TRADING IS HALTED !!! -- run /daily to investigate"
    } else {
        Log "CIRCUIT BREAKER: clear -- trading enabled"
    }
    Log "REGIME: $($risk.regime) | Consecutive losses: $($risk.consecutiveLosses)"
} catch {
    Log "RISK STATUS: could not fetch (server may still be starting)"
}

# 5. CHECK LAST TRADE DATE
try {
    $journal = Invoke-RestMethod -Uri 'http://localhost:3001/api/journal' -TimeoutSec 5
    $trades = $journal.trades
    if ($trades -and $trades.Count -gt 0) {
        $lastTrade = $trades[0].timestamp -replace 'T.*',''
        $daysSince = ((Get-Date) - [DateTime]$lastTrade).Days
        if ($daysSince -ge 3) {
            Log "TRADE ALERT: !!! NO TRADE IN $daysSince DAYS (last: $lastTrade) -- run /daily immediately"
        } else {
            Log "LAST TRADE: $lastTrade ($daysSince days ago)"
        }
    } else {
        Log "LAST TRADE: no trades in journal"
    }
} catch {
    Log "JOURNAL: could not fetch"
}

# 6. RUN DAILY AI ANALYSIS (once per day via claude -p)
$today    = Get-Date -Format 'yyyyMMdd'
$dailyFlag = "$proj\tasks\.daily_ran_$today"
if (-not (Test-Path $dailyFlag)) {
    Log "DAILY AI: starting (this may take a few minutes in background)..."
    New-Item $dailyFlag -Force | Out-Null
    $dailyLog = "$proj\tasks\logs\daily_runner_$today.txt"
    Start-Process -FilePath 'claude' `
        -ArgumentList '-p "Run /daily -- full daily automated check. Run every step. Stop after the report." --dangerously-skip-permissions' `
        -WorkingDirectory $proj `
        -RedirectStandardOutput $dailyLog `
        -NoNewWindow
    Log "DAILY AI: running in background -> $dailyLog"
} else {
    Log "DAILY AI: already ran today"
}

Log "=== Auto-Start Complete ==="
Log "Open JARVIS: claude (in this directory)"
Log "Dashboard:   http://localhost:3001/dashboard/index.html"
Log "Signals:     http://localhost:3001/api/signals"
