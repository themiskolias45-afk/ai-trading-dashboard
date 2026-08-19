# Bring the Contabo VPS up to the laptop's code. Runs FROM the laptop.
#
# WHY THIS EXISTS
# The VPS is not a variant of this codebase, it is BEHIND it. Measured 2026-08-19 by
# pulling every differing file down and diffing both directions:
#
#   routes on the laptop but not the VPS ... 19   (calendar, fleet, doctor, fvg,
#                                                  evidence-board, live-vs-replay, now,
#                                                  deep-plan, preopen-plan, near-miss,
#                                                  ai-registry, ai-work, measurements,
#                                                  cohort-reachability, learning-growth,
#                                                  rejection-evidence, fleet-performance,
#                                                  mt5/candles/raw, /investment)
#   routes on the VPS but not the laptop ...  0
#   functions only on the VPS .............   0
#   files on the VPS but not local ........   0
#   box-specific lines in any of them .....   0
#
# So a copy DELETES NOTHING. Every "VPS-only" line is an older version of a line the
# laptop already has a newer form of. That was checked, not assumed, and it is the
# reason this script is a copy rather than the seven hand-patches the last attempt took.
#
# WHAT IT IS ALSO FIXING - these are live defects on the box that trades continuously:
#   - mcp_server.js reads `circuitBreakerOpen`, a field that does not exist, so
#     execute_trade would fire with the breaker OPEN.
#   - realizedRFromPrices has no MAX_PLAUSIBLE_RR cap, so one degenerate stop can
#     dominate every R figure that box serves.
#   - emaSeries has no EMA_SMA_SEED_MIN_MULTIPLE guard (EMA200 seed contamination).
#   - sizing.js's duplicate guard ignores DIRECTION, so a BUY and a SELL can both open.
#   - DAILY_RANGE_DEFAULT is "210d" against the laptop's "900d".
#
# THE RISK, STATED PLAINLY
# generateSignal, generateSignalMTF and emaSeries all change. The VPS will produce
# DIFFERENT SIGNALS after this than before it. That is the intent - every measurement in
# this project (gate 70, the cohort tables, every walk-forward) was made against the
# LAPTOP's engine, so the VPS has been trading an engine no measurement describes - but
# it is a real behavioural change on the box holding live positions, not a cosmetic sync.
#
# WHAT IT NEVER TOUCHES
# strategy_settings.json (per-machine BY DESIGN), keys.env, journal.json, learning.json,
# smartentry.db. Nothing is deleted; replaced files are copied to a timestamped folder
# under C:\vps-predeploy-backup first.
#
#   powershell -File tasks\deploy_vps_catchup.ps1              dry run, changes nothing
#   powershell -File tasks\deploy_vps_catchup.ps1 -Deploy      copy the files
#   powershell -File tasks\deploy_vps_catchup.ps1 -Deploy -Restart   ... and restart it

param(
  [switch]$Deploy,
  [switch]$Restart,
  [string]$VpsHost = "169.58.74.133",
  [string]$VpsUser = "administrator",
  [string]$Key     = "$env:USERPROFILE\.ssh\contabo_smartentry"
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

# The 17 files measured as differing on 2026-08-19. Kept explicit rather than globbed:
# a glob would silently start shipping whatever lands in these folders later, and the
# whole point is that this list was verified file by file.
$serverFiles = @(
  "autohealer.js", "db.js", "hermes.js", "hermes.test.js", "index.js",
  "mcp_server.js", "rejection_log.js", "sizing.js", "sizing.test.js"
)
$dashboardFiles = @(
  "command.html", "daily-plan.html", "index.html", "jarvis.html",
  "login.html", "performance.html", "plan.html", "system.html"
)

function Invoke-Vps([string]$Body) {
  # -EncodedCommand, never nested quotes: a nested-quote ssh to this box silently
  # returns LOCAL results with no error, which once produced a false "already deployed".
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Body))
  ssh -i $Key -o BatchMode=yes -o ConnectTimeout=15 "$VpsUser@$VpsHost" "powershell -NoProfile -EncodedCommand $enc"
}

Write-Output "VPS catch-up deploy  ->  $VpsUser@$VpsHost"
Write-Output ("  server:    " + ($serverFiles -join ", "))
Write-Output ("  dashboard: " + ($dashboardFiles -join ", "))

if (-not $Deploy) {
  Write-Output ""
  Write-Output "DRY RUN - nothing copied. Re-run with -Deploy to ship, -Deploy -Restart to"
  Write-Output "ship and restart. Read the header first: the engine functions change, so the"
  Write-Output "VPS will produce different signals afterwards. That is the point, and it is"
  Write-Output "still a real change on the box holding live positions."
  exit 0
}

# ── 1. Back up everything about to be replaced. Never delete, always copy aside. ──
$backupScript = @'
$ErrorActionPreference='Stop'
Set-Location C:\ai-trading-dashboard
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "C:\vps-predeploy-backup\$stamp"
New-Item -ItemType Directory -Force -Path "$backup\server","$backup\dashboard" | Out-Null
$files = @("server/autohealer.js","server/db.js","server/hermes.js","server/hermes.test.js","server/index.js","server/mcp_server.js","server/rejection_log.js","server/sizing.js","server/sizing.test.js","dashboard/command.html","dashboard/daily-plan.html","dashboard/index.html","dashboard/jarvis.html","dashboard/login.html","dashboard/performance.html","dashboard/plan.html","dashboard/system.html")
foreach ($f in $files) { if (Test-Path ($f -replace "/","\")) { Copy-Item ($f -replace "/","\") (Join-Path $backup ($f -replace "/","\")) -Force } }
Write-Output ("BACKUP=" + $backup)
Write-Output ("BACKED_UP=" + (Get-ChildItem $backup -Recurse -File).Count)
'@
Write-Output "`n[1/5] backing up on the VPS"
Invoke-Vps $backupScript

# ── 2. Copy ────────────────────────────────────────────────────────────────────
Write-Output "`n[2/5] copying files"
$serverPaths = $serverFiles | ForEach-Object { Join-Path "$root\server" $_ }
scp -i $Key -o BatchMode=yes $serverPaths "${VpsUser}@${VpsHost}:C:/ai-trading-dashboard/server/"
if ($LASTEXITCODE -ne 0) { Write-Output "SERVER COPY FAILED ($LASTEXITCODE) - stopping before anything is restarted"; exit 1 }
$dashPaths = $dashboardFiles | ForEach-Object { Join-Path "$root\dashboard" $_ }
scp -i $Key -o BatchMode=yes $dashPaths "${VpsUser}@${VpsHost}:C:/ai-trading-dashboard/dashboard/"
if ($LASTEXITCODE -ne 0) { Write-Output "DASHBOARD COPY FAILED ($LASTEXITCODE) - server files are already across; do not restart until this is resolved"; exit 1 }

# ── 3. Syntax-check BEFORE any restart. A broken index.js that is never loaded is
#       a recoverable morning; one that is loaded takes the trading box down. ──────
Write-Output "`n[3/5] syntax check on the VPS"
$checkScript = @'
$ErrorActionPreference='Continue'
Set-Location C:\ai-trading-dashboard
node --check server\index.js;      Write-Output ("CHECK_index="      + $LASTEXITCODE)
node --check server\sizing.js;     Write-Output ("CHECK_sizing="     + $LASTEXITCODE)
node --check server\mcp_server.js; Write-Output ("CHECK_mcp="        + $LASTEXITCODE)
node --check server\autohealer.js; Write-Output ("CHECK_autohealer=" + $LASTEXITCODE)
node --check server\db.js;         Write-Output ("CHECK_db="         + $LASTEXITCODE)
node --check server\hermes.js;     Write-Output ("CHECK_hermes="     + $LASTEXITCODE)
node --check server\rejection_log.js; Write-Output ("CHECK_rejlog="  + $LASTEXITCODE)
'@
$checkOut = Invoke-Vps $checkScript
$checkOut
if ($checkOut -match "CHECK_\w+=[^0]") {
  Write-Output "`nA SYNTAX CHECK FAILED. Not restarting. Restore from the backup folder printed above."
  exit 1
}

if (-not $Restart) {
  Write-Output "`n[4/5] SKIPPED - files are in place but the running server still holds the OLD"
  Write-Output "code in memory. Nothing changes until it restarts. Re-run with -Restart, or"
  Write-Output "restart by hand. This is a safe state to stop in."
  exit 0
}

# ── 4. Restart. Stop the task, then kill ONLY the node process holding 3001.
#       Never a tree kill: that takes the MT5 bridge with it, and the bridge is what
#       manages open positions. ────────────────────────────────────────────────────
Write-Output "`n[4/5] restarting the VPS server"
$restartScript = @'
$ErrorActionPreference='Continue'
Set-Location C:\ai-trading-dashboard
try { Stop-ScheduledTask -TaskName "SmartEntryServer" -ErrorAction Stop; Write-Output "TASK_STOPPED=1" }
catch { Write-Output ("TASK_STOP_NOTE=" + $_.Exception.Message) }
$owning = (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
if ($owning) {
  foreach ($procId in $owning) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq "node") { Stop-Process -Id $procId -Force; Write-Output ("KILLED_NODE_PID=" + $procId) }
    else { Write-Output ("REFUSED_NON_NODE_PID=" + $procId + " name=" + $p.ProcessName) }
  }
} else { Write-Output "NO_LISTENER_ON_3001" }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "SmartEntryServer"
Write-Output "TASK_STARTED=1"
'@
Invoke-Vps $restartScript

# ── 5. Verify the box came back, and that the new routes actually answer ─────────
Write-Output "`n[5/5] verifying - waiting for the server to come up"
$verifyScript = @'
$ErrorActionPreference='Continue'
$deadline = (Get-Date).AddSeconds(90)
$up = $false
while ((Get-Date) -lt $deadline -and -not $up) {
  try { $s = Invoke-RestMethod -Uri "http://localhost:3001/api/status" -TimeoutSec 5; $up = $true }
  catch { Start-Sleep -Seconds 5 }
}
Write-Output ("SERVER_UP=" + $up)
if ($up) {
  Write-Output ("STARTED_AT=" + $s.startedAt)
  foreach ($r in @("/api/risk-status","/api/calendar","/api/now","/api/fvg","/api/evidence-board","/api/doctor")) {
    try { $null = Invoke-RestMethod -Uri ("http://localhost:3001" + $r) -TimeoutSec 20; Write-Output ("ROUTE " + $r + " = OK") }
    catch { Write-Output ("ROUTE " + $r + " = " + $_.Exception.Response.StatusCode.value__) }
  }
}
'@
Invoke-Vps $verifyScript

Write-Output "`nNow run:  node tasks\vps_parity.cjs"
Write-Output "Expect ENGINES AGREE. Verify it BY HAND before believing it - a false AGREE was"
Write-Output "recorded on 2026-08-19 at 07:52 while 3 functions and 2 constants differed."
