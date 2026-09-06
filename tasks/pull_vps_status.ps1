# Pulls the VPS's EA status files onto this laptop so the local dashboard can show the
# EA that actually runs there.
#
# WHY. The CRT EA runs on the VPS. The Auto Trade panel reads dashboard/*.json from the box
# it is served from, so on the laptop it correctly reported "no runtime status on this box"
# and Status UNKNOWN - true, but useless when what you want to know is whether the EA is
# alive. Each box reporting only itself is right for SmartEntry, whose bridges genuinely
# differ per box; it is wrong for a single EA that lives on one machine.
#
# The files carry their own `host` field (VMI3465345), which the panel prints in the sync
# line, so a pulled status can never be mistaken for the laptop's own.
#
# READ-ONLY ON THE VPS. scp reads two files. It starts nothing, stops nothing, and changes
# nothing there. Locally it writes only those two files into dashboard\.
$ErrorActionPreference = 'SilentlyContinue'

$Root = 'C:\Users\User\ai-trading-dashboard'
$Log  = "$Root\tasks\logs\pull_vps_status.txt"
if (-not (Test-Path "$Root\tasks\logs")) { New-Item -ItemType Directory -Force "$Root\tasks\logs" | Out-Null }
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Encoding utf8 $Log }

# tv-paper-positions.json added 2026-09-06: TradingView paper trades are invisible to
# /api/mt5/positions (built from bridge reports) and to the trade ledger (built from MT5 deal
# history). The browser that can see them runs on the VPS, so the laptop can only ever show
# them by pulling this file.
$files = @('mt5-runtime-status.json', 'ea-crt-weekly-review.json', 'tv-paper-positions.json', 'tv-paper-account.json')
$ok = 0

# REFRESH THE SOURCE BEFORE PULLING IT.
#
# Measured 2026-09-06: the VPS task "MT5 Ensure Running" launches powershell.exe - Task
# Scheduler's own Operational log records the launch and a successful completion one second
# later - but the script NEVER EXECUTES. No START line, no log entry, no file written, and
# LastTaskResult stays 0 with NumberOfMissedRuns 0. Verified it is not the script (the task's
# exact command line runs correctly over SSH and writes), not the arguments (byte-checked,
# pure ASCII, path resolves), not the file encoding (no BOM, zero non-ASCII), and not the
# RunLevel (the CRT/TK/FVG shadow tasks are equally 'Limited' and write every few minutes).
#
# The consequence was silent and user-visible: the status file aged past 30 minutes and the
# AI Brain panel showed "Status UNKNOWN" while MT5, the EA and the trades were all perfectly
# healthy. A stale file read as a sick system.
#
# So this pull refreshes the source first rather than faithfully copying a frozen file. It is
# a workaround, not a fix - the VPS task is still not running - but it is in a script that
# demonstrably runs every 10 minutes, and it fails soft: if ssh is unavailable the pull still
# copies whatever is there, exactly as before.
$refresh = @'
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ai-trading-dashboard\tasks\mt5_ensure_running.ps1
'@
& ssh -o BatchMode=yes -o ConnectTimeout=20 vps $refresh 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Log "refresh over ssh failed (exit $LASTEXITCODE) - pulling whatever is on the VPS" }
foreach ($f in $files) {
    # Straight to the destination name: nothing on the laptop generates the runtime status,
    # and the weekly review from the box where the EA actually runs is the authoritative
    # one. A stale local copy would be worse than an overwritten one.
    & scp -o BatchMode=yes -o ConnectTimeout=15 "vps:C:/ai-trading-dashboard/dashboard/$f" "$Root\dashboard\$f" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok++ } else { Log "FAILED to pull $f (exit $LASTEXITCODE)" }
}

# Report what was actually pulled, so a silent failure cannot look like success.
$st = Get-Content "$Root\dashboard\mt5-runtime-status.json" -Raw | ConvertFrom-Json
if ($st) {
    Log ("pulled {0}/{1} | host={2} mt5={3} ea={4} trailOff={5} checkedAt={6}" -f `
         $ok, $files.Count, $st.host, $st.mt5Running, $st.eaName, $st.eaTrailOff, $st.checkedAt)
    "host        : $($st.host)"
    "mt5Running  : $($st.mt5Running)"
    "eaAttached  : $($st.eaAttached)"
    "eaName      : $($st.eaName)"
    "eaTrailOff  : $($st.eaTrailOff)"
    "checkedAt   : $($st.checkedAt)"
} else {
    Log "pulled $ok/$($files.Count) but the runtime status file could not be read"
    "could not read the pulled status file"
}
