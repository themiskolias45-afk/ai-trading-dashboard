# CI/CD VPS Deploy — pull latest code to VPS, verify engine parity.
# Usage: .\tasks\deploy_vps.ps1 [-DryRun] [-Branch <name>]
#
# WHAT IT DOES
#   1. SSH into the VPS and run git pull on the deploy branch
#   2. Runs node tasks/vps_parity.cjs locally to compare engines
#   3. Sends a notification on success or failure
#   4. Logs result to tasks/logs/deploy_vps.txt
#
# PREREQUISITES
#   - SSH key configured for VPS (no password prompt)
#   - VPS_HOST set in keys.env (e.g. 169.58.74.133)
#   - VPS_USER set in keys.env (e.g. User or Administrator)
#   - Git on the VPS with the repo already cloned
#
# NEVER touch: learning.json, journal.json, smartentry.db, strategy_settings.json
# Those are per-machine and MUST NOT be overwritten by a deploy.

param(
    [switch]$DryRun,
    [string]$Branch = "claude/backup-deploy-server-FWgpv"
)

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$logDir  = Join-Path $root "tasks\logs"
$logFile = Join-Path $logDir "deploy_vps.txt"
$parity  = Join-Path $root "tasks\vps_parity.cjs"
$ts      = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Log([string]$msg, [string]$color = "White") {
    $line = "[$ts] $msg"
    Write-Host $line -ForegroundColor $color
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

# ── Load VPS connection details from keys.env ──────────────────────────────
$envFile = Join-Path $root "keys.env"
$vpsHost = $null
$vpsUser = "User"
$vpsPath = "C:\Users\User\ai-trading-dashboard"

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^VPS_HOST=(.+)$')  { $vpsHost = $Matches[1].Trim() }
        if ($_ -match '^VPS_USER=(.+)$')  { $vpsUser = $Matches[1].Trim() }
        if ($_ -match '^VPS_PATH=(.+)$')  { $vpsPath = $Matches[1].Trim() }
    }
}

if (-not $vpsHost) {
    Log "ERROR: VPS_HOST not set in keys.env. Add: VPS_HOST=<ip-address>" "Red"
    exit 1
}

Log "=== VPS Deploy starting ===" "Cyan"
Log "Branch: $Branch | VPS: $vpsUser@$vpsHost | DryRun: $DryRun"

# ── Safety: check for open positions before deploy ─────────────────────────
try {
    $riskRaw = Invoke-RestMethod -Uri "http://localhost:3001/api/risk-status" -TimeoutSec 5 -ErrorAction SilentlyContinue
    if ($riskRaw.openPositions -gt 0) {
        Log "WARNING: $($riskRaw.openPositions) open position(s). Bridge will continue during deploy." "Yellow"
        Log "         Broker SL/TP remain live. Deploy only affects code, not open trades." "Yellow"
    }
} catch {
    Log "Server offline or unreachable — risk check skipped." "Yellow"
}

if ($DryRun) {
    Log "[DRY RUN] Would run on VPS: cd '$vpsPath' && git fetch && git checkout $Branch && git pull" "Yellow"
    Log "[DRY RUN] Would then run: node tasks/vps_parity.cjs" "Yellow"
    exit 0
}

# ── SSH into VPS and pull ──────────────────────────────────────────────────
$sshTarget = "$vpsUser@$vpsHost"
$sshCmd    = "cd '$vpsPath' && git fetch origin $Branch && git checkout $Branch && git pull origin $Branch 2>&1"

Log "SSH: $sshTarget — running git pull..."
try {
    $pullOut = ssh $sshTarget $sshCmd 2>&1
    $pullOk  = $LASTEXITCODE -eq 0
    Log "Git pull output: $($pullOut -join ' | ')"
    if (-not $pullOk) {
        Log "ERROR: git pull failed on VPS. Aborting." "Red"
        exit 1
    }
    Log "Git pull OK." "Green"
} catch {
    Log "SSH failed: $_" "Red"
    exit 1
}

# ── Run VPS parity check ──────────────────────────────────────────────────
if (Test-Path $parity) {
    Log "Running vps_parity.cjs..."
    $parityOut = & node $parity 2>&1
    $parityOk  = $LASTEXITCODE -eq 0
    Log "Parity output: $($parityOut -join ' | ')"
    if (-not $parityOk) {
        Log "PARITY CHECK FAILED — engines diverged. Check vps_parity.cjs output above." "Red"
        # Notify
        & python "$root\notifications.py" "alert" "VPS deploy: PARITY FAIL — engines diverged. Check logs." --title "JARVIS Deploy" 2>$null
        exit 2
    }
    Log "Engines agree — parity OK." "Green"
} else {
    Log "vps_parity.cjs not found — skipping parity check." "Yellow"
}

# ── Notify success ────────────────────────────────────────────────────────
Log "Deploy complete. Branch: $Branch" "Green"
& python "$root\notifications.py" "alert" "VPS deploy OK. Branch $Branch. Engines agree." --title "JARVIS Deploy" 2>$null

Log "=== Deploy done ===" "Cyan"
exit 0
