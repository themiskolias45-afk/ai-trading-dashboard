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
# /api/status, NOT /api/health. Both exist, but /api/health is not in the server's
# no-login allowlist, so once DASHBOARD_USERNAME/PASSWORD were set it began answering
# 401 to this probe. Invoke-WebRequest THROWS on 401, the catch returns $false, and a
# healthy server read as absent — so this guard failed open and started a second node
# on every run, exactly like the Get-Process CommandLine guard below it.
$serverRunning = try { (Invoke-WebRequest -Uri 'http://localhost:3001/api/status' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop).StatusCode -eq 200 } catch { $false }
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
    $check = try { (Invoke-WebRequest -Uri 'http://localhost:3001/api/status' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop).StatusCode -eq 200 } catch { $false }
    if ($check) { Log "SERVER: started OK" } else { Log "SERVER: FAILED TO START -- check tasks\logs\server_err.txt" }
}

# 3. START MT5 BRIDGES (auto mode) -- exactly one per real MT5 account
#
# This block used to guard with:
#     Get-Process -Name 'python' | Where-Object { $_.CommandLine -like '*mt5_bridge*' }
# On PowerShell 5.1 a System.Diagnostics.Process object has NO CommandLine property,
# so that filter always returned nothing, the guard failed open, and this script
# started an extra bridge on every boot. That bridge ran untagged: it auto-detected
# whichever MT5 terminal answered first, landed on the same broker account as Bridge B,
# and opened every qualifying signal a second time. The 3-loss circuit breaker counts
# per ACCOUNT_TAG, so the duplicate split the loss count across two tags and neither
# ever reached the halt. Win32_Process is the only place PS 5.1 exposes a command line.
#
# The tag list is NOT hardcoded. It was @('A','B') until 2026-08-08, which meant this
# script started Bridge B on every logon no matter what MT5_EXPECTED_ACCOUNTS said --
# so stopping B never stuck, and account 11581419 kept ending up traded by this box and
# the VPS at once. tasks\bridge_tags.ps1 is the one parser; ensure_running.ps1 reads the
# same file, so the logon script and the scheduled safety net cannot disagree.
#
# A failed dot-source must not stop the bridges starting: falling back to @('A','B') is
# exactly the old behaviour, whereas an empty list would silently trade nothing.
$bridgeAccounts = @('A', 'B')
try {
    . (Join-Path $PSScriptRoot 'bridge_tags.ps1')
    $bridgeAccounts = Get-ExpectedBridgeTags -ProjectRoot $proj
} catch {
    Log "MT5 BRIDGE: cannot read bridge_tags.ps1 ($($_.Exception.Message)) -- assuming A,B"
}
Log "MT5 BRIDGE: this machine owns tag(s) $($bridgeAccounts -join ',')"

$bridgeProcs   = @()
$canReadProcs  = $true
try {
    $bridgeProcs = @(
        Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='cmd.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and ($_.CommandLine -like '*mt5_bridge*' -or $_.CommandLine -like '*start_bridge_*') }
    )
} catch {
    $canReadProcs = $false
    Log "MT5 BRIDGE: cannot read the process list ($($_.Exception.Message))"
    Log "MT5 BRIDGE: skipping launch -- starting blind risks a duplicate bridge on a live account"
}

if ($canReadProcs) {
    # Tagged wrappers own a python child whose own command line carries no tag,
    # so a bridge is 'tagged' if its parent is one of these wrapper processes.
    $taggedWrapperPids = @(
        $bridgeProcs | Where-Object { $_.CommandLine -like '*start_bridge_*' } |
            Select-Object -ExpandProperty ProcessId
    )

    foreach ($account in $bridgeAccounts) {
        $alreadyRunning = @($bridgeProcs | Where-Object { $_.CommandLine -like "*start_bridge_$account*" })
        if ($alreadyRunning.Count -gt 0) {
            Log "MT5 BRIDGE $($account): already running (PID $($alreadyRunning[0].ProcessId))"
        } else {
            Log "MT5 BRIDGE $($account): starting in auto mode..."
            # Launch through the tagged .bat so ACCOUNT_TAG, MT5_TERMINAL_PATH and
            # MT5_EXPECTED_LOGIN stay defined in exactly one place. The script writes
            # its own tasks\logs\bridge_log_$account.txt, so no redirection here.
            Start-Process -FilePath 'cmd' `
                -ArgumentList '/c', "tasks\start_bridge_$account.bat" `
                -WorkingDirectory $proj `
                -WindowStyle Minimized
            Start-Sleep 3
            Log "MT5 BRIDGE $($account): started"
        }
    }

    $strayBridges = @(
        $bridgeProcs | Where-Object {
            $_.Name -eq 'python.exe' -and
            $_.CommandLine -like '*mt5_bridge*' -and
            ($taggedWrapperPids -notcontains $_.ParentProcessId)
        }
    )
    if ($strayBridges.Count -gt 0) {
        $strayPids = ($strayBridges | Select-Object -ExpandProperty ProcessId) -join ', '
        Log "MT5 BRIDGE: WARNING -- $($strayBridges.Count) untagged bridge process(es) running (PID $strayPids)"
        Log "MT5 BRIDGE: untagged bridges report as account 'default' and can double a tagged bridge's positions -- stop them manually"
    }
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
    # { journal: [...] }, never { trades: [...] }, and entries carry openTime, not
    # timestamp. Both field names were wrong, so this logged "no trades in journal"
    # on every startup and the NO TRADE IN N DAYS alert could never fire.
    $journal = Invoke-RestMethod -Uri 'http://localhost:3001/api/journal' -TimeoutSec 5
    $trades = $journal.journal
    if ($trades -and $trades.Count -gt 0) {
        $lastTrade = $trades[0].openTime -replace 'T.*',''
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
    Start-Process -FilePath 'cmd' `
        -ArgumentList "/c claude -p ""Run /daily -- full daily automated check. Run every step. Stop after the report."" --dangerously-skip-permissions > ""$dailyLog"" 2>&1" `
        -WorkingDirectory $proj `
        -WindowStyle Hidden
    Log "DAILY AI: running in background -> $dailyLog"
} else {
    Log "DAILY AI: already ran today"
}

Log "=== Auto-Start Complete ==="
Log "Open JARVIS: claude (in this directory)"
Log "Dashboard:   http://localhost:3001/dashboard/index.html"
Log "Signals:     http://localhost:3001/api/signals"
