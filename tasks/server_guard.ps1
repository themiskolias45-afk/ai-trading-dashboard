# SmartEntry Server Guard - the headless half of ensure_running.
#
#   powershell -File tasks\server_guard.ps1            # check, and start if down
#   powershell -File tasks\server_guard.ps1 -WhatIfOnly # report only, start nothing
#
# ASCII ONLY. PowerShell 5.1 reads a .ps1 as ANSI without a BOM, so an em-dash arrives
# carrying a quote character and the file stops parsing.
#
# THE PROBLEM, measured on the laptop 2026-09-10
#
#   Windows booted 08:30:00 after an unexpected shutdown (Kernel-Power 41, 08:29:49).
#   ensure_running.txt logs "SERVER: up" every 10 minutes all night, stops dead at
#   08:21:17, and does not resume until 15:49:25 - when a human signed in.
#   SEVEN HOURS TWENTY-EIGHT MINUTES with the box powered on and the stack dead.
#
#   Cause: all 65 SmartEntry/JARVIS tasks on this box are LogonType=Interactive, and
#   NOT ONE has a boot trigger. "SmartEntry Ensure Running" already repeats every 10
#   minutes (PT10M since 2026-08-02) - the trigger was never the problem. Interactive
#   means no session, no run, whatever the trigger says.
#
#   Cost that day: SP500 #1959446094 stopped out at its SL for -$132.44 and the close
#   was only booked when the server came back (closeTime 14:49:51Z, the second of
#   startedAt 14:49:37Z, against closeTimeBroker 15:31:11Z - every other closed row
#   carries a clean ~3h broker offset, this one 41 minutes). XAUUSD #1972530807 sat
#   open and unmanaged the whole window. The TK ledger ran 13 setups / 1 executed here
#   against 24 / 3 on the VPS: setups this box simply never saw.
#
# WHY THIS IS A NEW TASK AND NOT A PRINCIPAL CHANGE ON ensure_running
#
#   The obvious fix is to flip "SmartEntry Ensure Running" to S4U. It is not safe.
#   ensure_running.ps1 guards the JARVIS window with [Environment]::UserInteractive,
#   but line 179 starts the MT5 TERMINAL with no such guard. Under S4U that launches
#   MT5 into session 0, which this repo has already had to write
#   tasks\fix_session0_contention.ps1 about. The VPS survives reboots because ITS
#   SmartEntryEnsureRunning runs as SYSTEM - but that is a DIFFERENT FILE
#   (md5 214d0cfa vs ff43ca7e here), so its safety does not transfer.
#
#   So this script does the one part that is provably desktop-free: the server. No
#   MT5, no bridges, no tunnel, no JARVIS window, no browser. Everything it does not
#   do stays exactly where it is, still handled by ensure_running once someone logs
#   in. Nothing existing is modified, so the working logged-in path cannot regress.
#
# WHAT IT RECOVERS, AND WHAT IT DOES NOT
#   Recovers headless: the API, the engine, the executors and shadow runners, the
#   journal, the rejection ledger and every learning file that accumulates server-side.
#   That is standing rule 2 - never block learning - which a dead box breaks for hours.
#   Does NOT recover: the MT5 bridge, which needs a desktop. Closing that gap is an
#   autologon decision, not a script.

param(
    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Continue'

$Proj    = Split-Path -Parent $PSScriptRoot
$LogDir  = Join-Path $Proj 'tasks\logs'
$LogFile = Join-Path $LogDir 'server_guard.txt'

# Same probe ensure_running uses, for the same reason stated there: a node process
# that is alive but wedged is not a running server, and several npx MCP servers also
# match *index.js*, so the process list cannot answer this question.
$SERVER_URL       = 'http://localhost:3001/api/signals'
$SERVER_TIMEOUT_S = 6

# A cold boot took 15s on 2026-08-12 and a flat 8s sleep missed it by 3 seconds.
# Poll, do not guess.
$SETTLE_TIMEOUT_S = 45
$SETTLE_POLL_S    = 3

$LOG_MAX_BYTES = 2MB

New-Item -ItemType Directory -Force $LogDir | Out-Null

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Output $line
    try {
        # Trim rather than delete. Standing rule 6: nothing is deleted. This file is
        # the only record of what a headless recovery actually did.
        if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $LOG_MAX_BYTES)) {
            $keep = Get-Content $LogFile -Tail 2000
            Set-Content -Path $LogFile -Value $keep -Encoding utf8
        }
        Add-Content -Path $LogFile -Value $line -Encoding utf8
    } catch {
        # A log write must never stop a repair.
    }
}

function Test-ServerUp {
    try {
        $null = Invoke-RestMethod -Uri $SERVER_URL -TimeoutSec $SERVER_TIMEOUT_S -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

$sessionKind = if ([Environment]::UserInteractive) { 'interactive' } else { 'headless' }

if (Test-ServerUp) {
    # The quiet path, and the common one. Logged at every run on purpose: a guard that
    # only writes when it acts cannot be told apart from a guard that never ran.
    Write-Log "SERVER: up ($sessionKind session) -- nothing to do"
    exit 0
}

if ($WhatIfOnly) {
    Write-Log "SERVER: DOWN ($sessionKind session) -- would start it. -WhatIfOnly, so nothing was started."
    exit 0
}

Write-Log "SERVER: down ($sessionKind session) -- starting"

# The identical launch line ensure_running.ps1 uses at its section 2. Deliberately not
# a new invention: this exact command has started this server on this box for weeks,
# and a guard that starts the server a second, different way is a guard that has never
# really been tested. If node is already bound to 3001 the duplicate fails its port
# bind and exits on its own - the same exposure ensure_running already carries.
Start-Process -FilePath 'cmd' `
    -ArgumentList '/c', 'cd server && node index.js >> ..\tasks\logs\server_log.txt 2>&1' `
    -WorkingDirectory $Proj -WindowStyle Minimized

$waited   = 0
$serverUp = $false
while (-not $serverUp -and $waited -lt $SETTLE_TIMEOUT_S) {
    Start-Sleep -Seconds $SETTLE_POLL_S
    $waited += $SETTLE_POLL_S
    $serverUp = Test-ServerUp
}

if ($serverUp) {
    try {
        $status = Invoke-RestMethod -Uri 'http://localhost:3001/api/status' -TimeoutSec $SERVER_TIMEOUT_S -ErrorAction Stop
        # startedAt is the proof, not the exit code. A task exit of 0 has meant "the
        # launcher ran", never "the server came back", more than once in this repo.
        Write-Log "SERVER: up after ${waited}s -- startedAt=$($status.startedAt)"
    } catch {
        Write-Log "SERVER: answering after ${waited}s but /api/status did not read back"
    }
    exit 0
}

Write-Log "SERVER: STILL NOT ANSWERING after ${waited}s -- see tasks\logs\server_log.txt"
exit 1
