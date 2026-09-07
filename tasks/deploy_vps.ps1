# VPS DEPLOY CHECK - it REFUSES to git-pull, and verifies instead.
# Usage: .\tasks\deploy_vps.ps1 [-Branch <name>]
#
# ============================================================================
# WHY THIS NO LONGER PULLS
# ============================================================================
# This file used to run `git fetch && git checkout && git pull` on the VPS. That
# premise does not match this fleet. Measured on the box 2026-08-31:
#
#     HEAD             ba1077b
#     ahead_of_origin  38          <- commits this repo has never seen
#     server/index.js  DIRTY
#     dirty files      776
#
# The VPS history diverged long ago and its server/index.js is PATCHED IN PLACE on
# purpose, because the two boxes differ in non-engine ways by design. A pull that
# succeeded would silently overwrite that and undo a verified deploy. A pull that
# failed would leave a half-applied state on the box that trades. Neither is wanted,
# so this script does not offer the choice.
#
# HOW DEPLOYS ACTUALLY WORK HERE:
#   1. write a small python patch script that ASSERTS its anchors and refuses to
#      run twice, then scp it to tasks\_clifirst_patch\ (or similar)
#   2. back up server\index.js first and verify the copy by SHA1
#   3. apply in place, then run: node --check server\index.js
#   4. restart with Start-ScheduledTask SmartEntryServer  (Administrator, S4U)
#      after Stop-Process -Force -Confirm:$false on the single port-3001 listener
#   5. WAIT for /api/signals to report dataSource "mt5" before comparing anything -
#      right after a restart it reads "yahoo" and BTC collapses to the daily-only 40
#   6. compare /api/signals before vs after, then node tasks\vps_parity.cjs --emit
#
# ============================================================================
# WHY THIS FILE IS PURE ASCII
# ============================================================================
# It previously contained em dashes and box-drawing characters. The file is UTF-8
# with no BOM, and Windows PowerShell 5.1 decodes a BOM-less .ps1 as cp1252, where
# the UTF-8 bytes of an em dash (E2 80 94) become  a  euro  U+201D - and PowerShell
# HONOURS U+201D as a string delimiter. Every em dash silently closed a string, so
# the whole script died with "The token '&&' is not a valid statement separator"
# pointing at lines that were never the problem. It never executed a single line.
# Keep this file ASCII-only, or give it a BOM.
#
# EXIT CODES follow this project's convention:
#   0  checks ran, engines agree
#   2  engines diverge - the two boxes can admit different trades from the same bars
#   3  NEEDS A PERSON - could not reach the box, or a decision is required
# It never changes anything on either machine.

param(
    [string]$Branch = "claude/backup-deploy-server-FWgpv"
)

$root    = Split-Path -Parent $PSScriptRoot
$logDir  = Join-Path $root "tasks\logs"
$logFile = Join-Path $logDir "deploy_vps.txt"
$parity  = Join-Path $root "tasks\vps_parity.cjs"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Log([string]$msg, [string]$color = "White") {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line -ForegroundColor $color
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

Log "=== VPS deploy CHECK starting (this script never pulls) ===" "Cyan"

# --- Where is the VPS? keys.env wins; the ssh alias is the fallback that works. ---
# The old version defaulted to User@... and C:\Users\User\ai-trading-dashboard, both
# wrong here, and built "user@host" by hand which BYPASSES the ssh config alias and
# therefore its IdentityFile. The alias is the thing that is actually configured.
$sshTarget = "vps"
$vpsPath   = "C:\ai-trading-dashboard"
$envFile   = Join-Path $root "keys.env"
if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile)) {
        if ($line -match '^VPS_SSH_ALIAS=(.+)$') { $sshTarget = $Matches[1].Trim() }
        if ($line -match '^VPS_PATH=(.+)$')      { $vpsPath   = $Matches[1].Trim() }
    }
}
Log "ssh target: $sshTarget   repo: $vpsPath   branch: $Branch"

# --- Open positions. The old gate read $riskRaw.openPositions, a field that does not
# --- exist on /api/risk-status, so it could never fire. This reads the list itself.
try {
    $pos = Invoke-RestMethod -Uri "http://localhost:3001/api/mt5/positions" -TimeoutSec 8
    $openCount = @($pos.positions).Count
    if ($openCount -gt 0) {
        Log "NOTE: $openCount open position(s) on this box. Broker SL/TP stay live; nothing here touches them." "Yellow"
    } else {
        Log "No open positions on this box."
    }
} catch {
    Log "Local server unreachable - position check skipped (not a failure of this script)." "Yellow"
}

# --- State of the VPS repo, which is why the pull is refused. Read-only. ---
# Built as one cmd.exe line joined with " & ". Two traps, both hit while writing this:
#   1. Join on ANY newline. This file may be saved LF-only, so a CRLF-only -replace
#      leaves the newlines in, ssh gets a multi-line command, and the probe returns
#      BLANK FIELDS while looking like it worked.
#   2. Do NOT pipe to `find /c /v ""` over ssh. The empty-string argument does not
#      survive the hop: FIND answers "Parameter format not correct" and the whole ssh
#      call exits 2, which then reads as "the VPS is unreachable" when it is fine.
#      Count lines locally instead.
$probeLines = @(
    # PARENTHESISED ON PURPOSE. In PowerShell the comma binds TIGHTER than +, so
    #     'cd /d ' + $vpsPath, 'echo ...', 'git ...'
    # parses as 'cd /d ' + ($vpsPath, 'echo ...', 'git ...') - string PLUS ARRAY,
    # which stringifies the array space-separated into ONE element. -join then has
    # a single item to join and inserts no ' & ' at all, so ssh receives
    # 'cd /d C:\... echo BOX=... git rev-parse ...' and cmd answers
    # 'The system cannot find the path specified.' with empty stdout.
    ('cd /d ' + $vpsPath),
    'echo BOX=%COMPUTERNAME%',
    'git rev-parse --short HEAD',
    'git status --porcelain server/index.js'
)
$remote = $probeLines -join ' & '

$vpsHead     = "unknown"
$vpsIndexJs  = "unknown"
$vpsDirty    = "unknown"
try {
    $out = @(ssh $sshTarget $remote)
} catch {
    Log "ssh threw: $_" "Red"
    Log "=== done (exit 3, needs a person) ===" "Red"
    exit 3
}

# Judge reachability by the MARKER, not by the exit code: a non-zero exit from one
# chained command does not mean the box is unreachable.
if (-not ($out -match '^BOX=')) {
    Log "No BOX= marker back from ssh alias '$sshTarget' - treating the VPS as unreachable." "Red"
    Log "  raw: $($out -join ' | ')" "Red"
    Log "=== done (exit 3, needs a person) ===" "Red"
    exit 3
}

$vpsBox     = ($out | Where-Object { $_ -match '^BOX=' }        | Select-Object -First 1)
$vpsHead    = ($out | Where-Object { $_ -match '^[0-9a-f]{7,}$' } | Select-Object -First 1)
$vpsIndexJs = if ($out -match 'server/index\.js') { "DIRTY" } else { "clean" }
Log "VPS answered: $vpsBox"

# Tracked modifications only - that is what a pull would actually collide with.
$dirtyOut = @(ssh $sshTarget ('cd /d ' + $vpsPath + ' & git status --porcelain --untracked-files=no'))
if ($dirtyOut.Count -gt 0) { $vpsDirty = $dirtyOut.Count }

$localHead = (git -C $root rev-parse --short HEAD)
Log "HEAD local=$localHead  vps=$vpsHead   index.js on VPS: $vpsIndexJs   tracked-dirty there: $vpsDirty"
Log "PULL REFUSED BY DESIGN. The VPS index.js is patched in place; a pull would" "Yellow"
Log "overwrite it. See the header of this file for the procedure that works." "Yellow"

# --- The useful half: does the box that trades run the same engine? ---
if (-not (Test-Path $parity)) {
    Log "vps_parity.cjs not found - cannot verify engines. Nothing was changed." "Red"
    Log "=== done (exit 3, needs a person) ===" "Red"
    exit 3
}

Log "Running vps_parity.cjs --emit ..."
# --emit matters: without it the run does not record, so nothing downstream can read
# the result. Capture the REAL exit code - the verdict text alone is not the answer.
& node $parity --emit | ForEach-Object { Log "  $_" }
$parityExit = $LASTEXITCODE

if ($parityExit -eq 0) {
    Log "ENGINES AGREE - same signal from the same bars." "Green"
    Log "=== done (exit 0) ===" "Cyan"
    exit 0
}

Log "ENGINE DRIFT (parity exit $parityExit). The two boxes can admit different trades" "Red"
Log "from identical bars, and numbers pooling both journals are unattributable." "Red"
& python (Join-Path $root "notifications.py") "alert" "VPS check: ENGINE DRIFT - parity exit $parityExit" --title "JARVIS Deploy Check" 2>$null
Log "=== done (exit 2) ===" "Red"
exit 2
