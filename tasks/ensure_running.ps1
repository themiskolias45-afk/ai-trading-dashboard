# SmartEntry Pro -- gap filler.
#
# Starts ONLY what is missing and never kills anything. Safe to run on a schedule,
# on unlock, at logon, and by hand, in any order and any number of times.
#
# WHY THIS EXISTS
# Everything that started SmartEntry automatically fired on LOGON: the Startup
# folder shortcuts and the SmartEntryPro scheduled task. Opening a laptop lid is a
# resume and an unlock, not a logon -- no trigger fires and the Startup folder is not
# re-read. On 2026-08-02 the machine had been up for 18 days, so nothing had
# auto-started since 15 July and the stack was only ever running because somebody
# launched it by hand. The companion scheduled task (tasks\install_autostart.ps1)
# fires this on unlock and every few minutes; this script is what makes that safe to
# repeat.
#
# WHY IT NEVER KILLS
# START.bat is a cold-start script: it kills its own previous processes, then starts
# a full stack, opens a browser and a claude window. Correct at logon, wrong every
# ten minutes. This one only fills gaps, so a running system is left completely
# alone and a half-dead one is repaired without disturbing the healthy half.

$ErrorActionPreference = 'Stop'

# Derived from this file's own location, never hardcoded. The laptop keeps the
# project under C:\Users\User and the VPS at C:\ai-trading-dashboard, and a hardcoded
# path is why this script could only ever run on one of the two boxes -- leaving the
# VPS, a headless server nobody logs into, with no gap-filler at all.
$Proj    = Split-Path -Parent $PSScriptRoot
$LogDir  = Join-Path $Proj 'tasks\logs'
$LogFile = Join-Path $LogDir 'ensure_running.txt'
$LOG_MAX_BYTES = 2MB

# Terminals are DETECTED, not assumed. The VPS has one MT5 install and the laptop
# two; naming a path that does not exist on this box would log a permanent false
# alarm, and the whole point of this script is that nothing is blind.
$TerminalCandidates = @(
    'C:\Program Files\MetaTrader 5\terminal64.exe',
    (Join-Path $env:APPDATA 'MetaTrader 5\terminal64.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

# Laptop-only: the tunnel that serves the VPS dashboard on a localhost origin. Absent
# key means this box does not own the tunnel, which is not a fault.
$TunnelKey = Join-Path $env:USERPROFILE '.ssh\contabo_smartentry'

# A headless server has no desktop to open a JARVIS window on. Session 0 / no
# interactive desktop must skip that step rather than fail it forever.
$IsInteractive = [Environment]::UserInteractive
$TUNNEL_LOCAL_PORT = 3002
$SERVER_URL        = 'http://localhost:3001/api/signals'
$SERVER_TIMEOUT_S  = 6
# The server needs a moment before it answers. This is a real wait, not a label:
# $serverUp gates the bridge start below, so declaring the server down too early
# leaves open positions with no bridge. Polled, because a cold boot took 15s on
# 2026-08-12 and a flat 8s sleep missed it by 3 seconds.
$SERVER_SETTLE_TIMEOUT_S = 45
$SERVER_SETTLE_POLL_S    = 3
# A bridge reports every 60s. Three missed reports is dead, not merely slow.
$BRIDGE_STALE_S    = 180
# A bridge needs ~30s to connect to MT5 and post its first heartbeat. Until then it
# still looks "not reporting", so a second run must not start another one.
$BRIDGE_START_COOLDOWN_S = 120
# How many consecutive runs may start a bridge that never comes up before the
# terminal, not the bridge, is named as the failed component.
#
# WHY THIS EXISTS
# On 2026-08-13 this script logged "TERMINAL 1: running (PID 11876)" at 09:51,
# 10:01 and 10:11 while the bridge logged twelve consecutive
# "MT5 initialize() failed -- (-10005, 'IPC timeout')". The terminal was alive as a
# process and refusing IPC. The script restarted the bridge six times -- the bridge
# was never the broken part -- and its own log read healthy for 23 minutes of dead
# execution. A process check is not a liveness check.
#
# Runs are ~10 min apart, so 3 is roughly 13 minutes of a bridge that cannot
# connect: past any legitimate slow start, well before today's 23.
$BRIDGE_MAX_FAILED_STARTS = 3

# Which bridge tags this machine owns. Single source of truth is
# MT5_EXPECTED_ACCOUNTS in keys.env -- the same variable the server's healer reads,
# so "what we start" and "what we alarm about missing" can never disagree.
#
# Local Bridge B and the VPS's Bridge A were both pinned to login 11581419 and both
# running --auto against separate circuit breakers, so that one account absorbed six
# consecutive losses before both halted, allowed 15 trades a day across the two caps,
# and had its trade record split in half between two journals. One bridge per account
# across the fleet is the fix; this is what stops the laptop restarting the duplicate.
#
# Falls back to 'A,B' on a missing file, an unreadable one, or an empty value. Never
# falls back to an empty list: that would silently start no bridges at all, which is a
# worse failure than starting one too many.
#
# The function itself moved to tasks\bridge_tags.ps1 on 2026-08-08. It used to live
# here only, and startup_all.ps1 hardcoded @('A','B') rather than calling it -- so this
# script honoured the flag while the logon script beside it restarted B anyway. If the
# dot-source fails, define the fallback rather than leaving the name undefined, or the
# bridge block below would throw and this box would lose its gap-filler entirely.
try {
    . (Join-Path $PSScriptRoot 'bridge_tags.ps1')
} catch {
    function Get-ExpectedBridgeTags { return @('A', 'B') }
}
if (-not (Get-Command Get-ExpectedBridgeTags -ErrorAction SilentlyContinue)) {
    function Get-ExpectedBridgeTags { return @('A', 'B') }
}

New-Item -ItemType Directory -Force $LogDir | Out-Null

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Output $line
    try {
        # Trim rather than delete: this file is the only record of what a headless
        # unlock actually did, and it is appended to every few minutes forever.
        if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $LOG_MAX_BYTES)) {
            $keep = Get-Content $LogFile -Tail 2000
            Set-Content -Path $LogFile -Value $keep -Encoding utf8
        }
        Add-Content -Path $LogFile -Value $line -Encoding utf8
    } catch {
        # A log write must never stop a repair.
    }
}

# Win32_Process is the only place PowerShell 5.1 exposes a command line --
# Get-Process objects have no CommandLine property at all, and a filter on one
# silently matches nothing, which is how this project started duplicate bridges on
# a live account for weeks. Returns $null (not an empty list) when the list cannot
# be read, so callers can tell "nothing running" from "cannot tell".
function Get-ProcTable {
    try {
        return @(Get-CimInstance Win32_Process -ErrorAction Stop |
                 Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath)
    } catch {
        Write-Log "PROCESS LIST: unreadable ($($_.Exception.Message))"
        return $null
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

Write-Log '--- ensure_running start ---'

$procs = Get-ProcTable

#  1. MT5 terminals 
# A bridge with no terminal is a bridge that logs "no bars" forever, so terminals
# come first. MT5 is single-instance per install: launching one that is already
# running just activates its window.
if ($TerminalCandidates.Count -eq 0) {
    Write-Log 'TERMINALS: no MT5 install found on this box -- nothing to start'
}
$terminalIndex = 0
# Counts terminals whose PROCESS is alive. Deliberately not called "healthy": a
# terminal can hold this count and still refuse every IPC call (see
# $BRIDGE_MAX_FAILED_STARTS). Section 3 uses it to tell "no terminal, so of course
# the bridge cannot connect" apart from "terminal is up and lying".
$terminalsRunning = 0
foreach ($termPath in $TerminalCandidates) {
    $terminalIndex++
    $term = @{ Tag = "$terminalIndex"; Path = $termPath }
    if ($null -eq $procs) {
        Write-Log "TERMINAL $($term.Tag): process list unreadable -- not starting blind"
        continue
    }
    $running = @($procs | Where-Object { $_.ExecutablePath -eq $term.Path })
    if ($running.Count -gt 0) {
        $terminalsRunning++
        Write-Log "TERMINAL $($term.Tag): running (PID $($running[0].ProcessId))"
    } else {
        Write-Log "TERMINAL $($term.Tag): starting"
        Start-Process -FilePath $term.Path -WindowStyle Minimized
    }
}

#  2. Server 
# Checked by HTTP, not by process name: a node process that is alive but wedged is
# not a running server, and several npx MCP servers also match *index.js*.
$serverUp = Test-ServerUp
if ($serverUp) {
    Write-Log 'SERVER: up'
} else {
    Write-Log 'SERVER: down -- starting'
    Start-Process -FilePath 'cmd' `
        -ArgumentList '/c', 'cd server && node index.js >> ..\tasks\logs\server_log.txt 2>&1' `
        -WorkingDirectory $Proj -WindowStyle Minimized
    $waited = 0
    while (-not $serverUp -and $waited -lt $SERVER_SETTLE_TIMEOUT_S) {
        Start-Sleep -Seconds $SERVER_SETTLE_POLL_S
        $waited += $SERVER_SETTLE_POLL_S
        $serverUp = Test-ServerUp
    }
    if ($serverUp) { Write-Log "SERVER: up (answered after ${waited}s)" }
    else { Write-Log "SERVER: still not answering after ${waited}s -- see tasks\logs\server_log.txt" }
}

#  3. Bridges A and B
# The one place this script can lose money, so it is the most conservative.
#
# Presence is decided by the SERVER, not by the process list. The first version of
# this section identified a bridge by its tagged wrapper's command line and started
# a second pair on 2026-08-02 while both bridges were alive and heartbeating:
# Win32_Process returns an EMPTY CommandLine and an empty ExecutablePath for these
# particular python processes (verified on PIDs 19424 and 16584 - cmdlen 0), so the
# filter matched nothing and the script concluded both were down. The same blind
# spot in a different guise as the PS 5.1 Get-Process trap.
#
# /api/mt5/health?account=X is written only by POST /api/mt5/positions, so a "true"
# there means a bridge is alive AND talking to both MT5 and the server - a stronger
# statement than any process check, and immune to WMI.
function Get-BridgeAge($tag) {
    # Returns age in seconds, or $null when that account has never reported or the
    # server cannot be reached. $null means "start it"; a number means "leave it".
    try {
        $h = Invoke-RestMethod -Uri "http://localhost:3001/api/mt5/health?account=$tag" `
                               -TimeoutSec $SERVER_TIMEOUT_S -ErrorAction Stop
        if ($h.connected -eq $true) { return [int]($h.ageMs / 1000) }
        return $null
    } catch {
        return $null
    }
}

# Consecutive runs that started bridge $tag and never saw it report. The count is
# the only thing carried between runs, and it is written, never deleted -- a zero
# and an absent file mean the same thing, so a failed write costs a warning, not a
# repair.
function Get-BridgeFailCount($tag) {
    try {
        $f = Join-Path $LogDir ".bridge_fails_$tag"
        if (-not (Test-Path $f)) { return 0 }
        $raw = (Get-Content $f -First 1 -ErrorAction Stop)
        $n = 0
        # A corrupt or half-written file reads as 0. Losing the count re-arms the
        # warning later than it should; throwing here would take the gap-filler
        # down with it, which is far worse.
        if ([int]::TryParse(($raw -as [string]).Trim(), [ref]$n) -and $n -ge 0) { return $n }
        return 0
    } catch {
        return 0
    }
}

function Set-BridgeFailCount($tag, $count) {
    try {
        Set-Content -Path (Join-Path $LogDir ".bridge_fails_$tag") `
                    -Value ([string]$count) -Encoding ascii -ErrorAction Stop
    } catch {
        Write-Log "BRIDGE $($tag): could not record fail count ($($_.Exception.Message))"
    }
}

# Fired once per episode, on the transition into the alarm state. Non-blocking on
# purpose: this script runs every ten minutes on a schedule and must never sit
# waiting on a notifier. Absent python or a failing notifier is logged and ignored.
function Send-TerminalAlert($text) {
    try {
        if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
            Write-Log 'ALERT: python not on PATH -- log line is the only record'
            return
        }
        # notifications.py exposes `alert "<message>" [--title T]` -- verified against
        # its arg parser, not assumed. Built as ONE argument string and stripped of
        # embedded quotes: PS 5.1 does not reliably re-quote an -ArgumentList array,
        # so a message with a space would otherwise arrive as several arguments and
        # the notifier would print usage and exit 1.
        $safe = ($text -replace '"', "'")
        Start-Process -FilePath 'python' `
            -ArgumentList ('notifications.py alert "{0}" --title "MT5 TERMINAL"' -f $safe) `
            -WorkingDirectory $Proj -WindowStyle Hidden
    } catch {
        Write-Log "ALERT: could not send ($($_.Exception.Message))"
    }
}

# With the server down, every account looks "not reporting" whether or not a bridge
# is actually running - and starting a second bridge on a live account is far worse
# than leaving a gap the watchdog will close a minute later.
if (-not $serverUp) {
    Write-Log 'BRIDGES: server is not answering, so bridge state is unknowable -- not starting blind'
}
# An untagged bridge reports as account "default". If one is alive, starting a
# tagged bridge can put two --auto bridges on ONE broker account, doubling every
# position while each keeps its own circuit-breaker count.
elseif ($null -ne ($strayAge = Get-BridgeAge 'default') -and $strayAge -lt $BRIDGE_STALE_S) {
    Write-Log "BRIDGES: an UNTAGGED bridge is reporting (last seen ${strayAge}s ago) -- skipping A and B entirely"
    Write-Log 'BRIDGES: stop it, then this script will start the tagged pair'
} else {
    $expectedTags = Get-ExpectedBridgeTags
    Write-Log "BRIDGES: this machine owns tag(s) $($expectedTags -join ',')"
    foreach ($tag in $expectedTags) {
        $age = Get-BridgeAge $tag
        if ($null -ne $age -and $age -lt $BRIDGE_STALE_S) {
            Write-Log "BRIDGE $($tag): reporting (${age}s ago)"
            # A bridge that reports has connected to MT5, so the terminal is
            # answering IPC. Reset by writing 0 rather than removing the file:
            # nothing in this project deletes state it did not just create.
            if ((Get-BridgeFailCount $tag) -ne 0) { Set-BridgeFailCount $tag 0 }
            continue
        }
        # Cooldown marker: a bridge takes ~30s to connect and first report, so two
        # runs in quick succession would otherwise both see "not reporting" and
        # start two. The marker is per tag and its age is the only state involved.
        $marker = Join-Path $LogDir ".bridge_started_$tag"
        if (Test-Path $marker) {
            $sinceStart = ((Get-Date) - (Get-Item $marker).LastWriteTime).TotalSeconds
            if ($sinceStart -lt $BRIDGE_START_COOLDOWN_S) {
                Write-Log "BRIDGE $($tag): not reporting, but started $([int]$sinceStart)s ago -- waiting"
                continue
            }
        }
        # Counted BEFORE the start, so the number means "runs that have tried and
        # failed", and only on the path that actually starts something -- the
        # cooldown and server-down paths above start nothing and must not count.
        $fails = (Get-BridgeFailCount $tag) + 1
        Set-BridgeFailCount $tag $fails

        Write-Log "BRIDGE $($tag): not reporting -- starting"
        Set-Content -Path $marker -Value (Get-Date -Format 'o') -Encoding ascii
        Start-Process -FilePath 'cmd' -ArgumentList '/c', "tasks\start_bridge_$tag.bat" `
            -WorkingDirectory $Proj -WindowStyle Minimized
        Start-Sleep -Seconds 3

        # THE POINT OF ALL THIS. Restarting the bridge again is still correct -- it
        # is cheap and it is right whenever the bridge is the broken part. What was
        # missing is the sentence that says it ISN'T: a terminal whose process is
        # alive while the bridge it feeds has failed to connect $BRIDGE_MAX_FAILED_STARTS
        # times running is a terminal refusing IPC, and no number of bridge restarts
        # will fix it. Someone has to look at the terminal.
        #
        # Nothing is killed here. MT5 is single-instance per install, so starting it
        # again only activates the window; the only real remedy is a manual restart
        # of the terminal, which is a human decision on a box with open positions.
        if ($fails -ge $BRIDGE_MAX_FAILED_STARTS) {
            if ($terminalsRunning -gt 0) {
                Write-Log "BRIDGE $($tag): FAILED TO CONNECT $fails RUNS RUNNING while $terminalsRunning MT5 terminal(s) show as running"
                Write-Log "TERMINAL: SUSPECT -- process alive but not answering IPC. Check tasks\logs\bridge_log_$tag.txt for 'IPC timeout'; restart MetaTrader 5 by hand and confirm it is logged in."
                # Once per episode, on the transition only, so a machine left in this
                # state does not send an alert every ten minutes forever.
                if ($fails -eq $BRIDGE_MAX_FAILED_STARTS) {
                    Send-TerminalAlert "Bridge $tag has failed to connect $fails runs in a row while MT5 is running. Terminal is alive but not answering IPC - restart MetaTrader 5 and check it is logged in. This box cannot execute until then."
                }
            } else {
                Write-Log "BRIDGE $($tag): failed to connect $fails runs running, and no MT5 terminal is up -- terminal start is the fix, see above"
            }
        }
    }
}

#  4. Watchdog guardian 
# The guardian restarts the watchdog; the watchdog restarts the server and bridges.
# count_guardians.ps1 fails SAFE (returns 99) when the process list cannot be read,
# so an unreadable list backs off instead of stacking supervisors.
try {
    $guardianCount = [int](& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Proj 'tasks\count_guardians.ps1'))
} catch {
    $guardianCount = 99
    Write-Log "GUARDIAN: count failed ($($_.Exception.Message)) -- assuming one is running"
}
if ($guardianCount -ge 1) {
    Write-Log "GUARDIAN: running ($guardianCount)"
} else {
    Write-Log 'GUARDIAN: starting'
    Start-Process -FilePath 'cmd' -ArgumentList '/c', 'tasks\watchdog_guardian.bat' `
        -WorkingDirectory $Proj -WindowStyle Minimized
}

#  5. VPS tunnel 
# Serves the VPS dashboard on a localhost origin so Chrome will grant the
# microphone for JARVIS voice. Presence is tested by the listening port, which is
# what actually matters, rather than by finding an ssh process.
if (-not (Test-Path $TunnelKey)) {
    Write-Log 'TUNNEL: ssh key not present -- skipped'
} else {
    $listening = $false
    try {
        $listening = @(Get-NetTCPConnection -LocalPort $TUNNEL_LOCAL_PORT -State Listen -ErrorAction Stop).Count -gt 0
    } catch {
        $listening = $false
    }
    if ($listening) {
        Write-Log "TUNNEL: up on localhost:$TUNNEL_LOCAL_PORT"
    } else {
        Write-Log 'TUNNEL: starting'
        Start-Process -FilePath 'cmd' -ArgumentList '/c', 'tasks\tunnel_vps.bat' `
            -WorkingDirectory $Proj -WindowStyle Minimized
    }
}

#  6. JARVIS window (the interactive claude CLI session)
#
# This was the last gap, and the reason "some of it starts and some of it doesn't".
# Only START.bat ever opened a JARVIS window, and START.bat runs from SmartEntryPro,
# which fires on LOGON ONLY and (until fixed) refused to start on battery. Opening a
# laptop lid is a resume, not a logon, so the trading stack came back here every ten
# minutes while JARVIS did not come back at all. The stack looked healthy and the
# thing the operator actually talks to was simply absent.
#
# DETECTION IS BY "Claude Code", NOT "JARVIS". START.bat launches the window as
# `start "JARVIS" cmd /k ... claude`, but the CLI immediately retitles it to
# "* Claude Code". Matching on JARVIS finds nothing and would open a fresh window
# every ten minutes, forever. Measured on this machine: the live session's title is
# "Claude Code".
#
# Deliberately conservative: ANY Claude Code window counts, even one opened for a
# different project. A false positive costs a missing JARVIS window that the user
# can open by hand; a false negative spawns duplicate sessions against the same
# subscription every ten minutes. Those are not symmetric.
if (-not $IsInteractive) {
    # The VPS is headless. Opening a console session nobody can see would burn
    # subscription on a window that never gets read.
    Write-Log 'JARVIS: no interactive desktop on this box -- skipped'
    Write-Log '--- ensure_running done ---'
    return
}

$jarvisRunning = $false
try {
    $claudeWindows = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match 'Claude Code' })
    $jarvisRunning = $claudeWindows.Count -gt 0
} catch {
    # Fail SAFE: an unreadable process list must not spawn a session.
    $jarvisRunning = $true
    Write-Log "JARVIS: window check failed ($($_.Exception.Message)) -- assuming one is open"
}

if ($jarvisRunning) {
    Write-Log 'JARVIS: window open'
} elseif (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Log 'JARVIS: claude CLI not on PATH -- skipped'
} else {
    Write-Log 'JARVIS: no window -- opening'
    # Inside the project on purpose. Unlike the unattended agents in claude_agent.py,
    # which run OUTSIDE it to avoid booting as JARVIS, this is the session that is
    # supposed to be JARVIS and load CLAUDE.md.
    Start-Process -FilePath 'cmd' -ArgumentList '/k', 'claude' -WorkingDirectory $Proj
}

Write-Log '--- ensure_running done ---'
