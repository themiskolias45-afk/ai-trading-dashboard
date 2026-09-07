# Keeps MT5 running on the VPS, and publishes what it can see so you can LOOK at it.
#
# WHY. Checked 2026-09-04: nothing on this box restarts MT5. No scheduled task, no Run key,
# an empty Startup folder. The terminal had been up 29 days and the VPS 40, so it had never
# bitten - but one Windows Update reboot would take the terminal down and, with it, the
# chart EA and the bridge's MT5 connection, silently, until a human noticed. That is the
# opposite of 24/7.
#
# IT NEVER KILLS. It starts MT5 only when no terminal64 process exists. There is no stop,
# no restart and no /kill path anywhere in this file: a terminal that is up is left exactly
# alone, mid-trade or not. Modelled on tasks\ensure_running.ps1, which fills gaps and never
# kills, and is therefore safe to run on any schedule.
#
# AutoAdminLogon is 1 on this box with an active console session, so after a reboot there
# is a real desktop for MT5 to start into. That matters: MT5 is a GUI application and a
# terminal started without a session cannot render charts or run a chart EA properly.
$ErrorActionPreference = 'SilentlyContinue'

# THE REPO ROOT IS DERIVED, NOT NAMED. Both of these were the literal
# 'C:\ai-trading-dashboard' - which is the VPS layout. The laptop repo is at
# C:\Users\User\ai-trading-dashboard, so on that box BOTH pointed at a tree that does not
# exist, and $ErrorActionPreference = 'SilentlyContinue' two lines above meant neither
# said so. Measured 2026-09-07:
#
#   $StatusOut  Move-Item into a missing directory failed silently, the script still
#               exited 0, and ensure_running.ps1:485 logged "MT5 status: refreshed here"
#               on every 10-minute tick while dashboard/mt5-runtime-status.json sat
#               202 minutes stale. Four "refreshed" lines against a file that never moved.
#
#   $CrtIni     WORSE, and never triggered. tasks/crt_start.ini exists in the laptop repo,
#               but Test-Path on the VPS path is false there, so the branch at :100 would
#               have fallen through to :104 and started MT5 BARE - no EA - on the box
#               whose own log line says "NO EA will attach". Latent because MT5 has not
#               been down while this ran on the laptop, which is not the same as safe.
#
# Split-Path -Parent $PSScriptRoot yields exactly 'C:\ai-trading-dashboard' on the VPS, so
# that box's behaviour is unchanged by construction rather than by testing. The fallback
# keeps the old literal for any invocation where $PSScriptRoot is empty, so this can never
# behave worse than it does today.
$Root      = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { 'C:\ai-trading-dashboard' }
$TermExe   = 'C:\Program Files\MetaTrader 5\terminal64.exe'
$CrtIni    = Join-Path $Root 'tasks\crt_start.ini'
# $env:APPDATA IS PER-USER, AND THIS SCRIPT RUNS UNDER TWO IDENTITIES. Measured
# 2026-09-07: SmartEntryEnsureRunning (SYSTEM, every 10 min) calls this through
# ensure_running.ps1, and the SYSTEM profile has its OWN MetaQuotes\Terminal\<hash>
# folder which EXISTS but holds 0 expert logs. The scan below therefore found nothing
# and wrote eaAttached=false with every EA field null; the Administrator-context run
# wrote the truth. Last writer wins and SYSTEM runs every 10 minutes, so the dashboard
# sat on a red it could not actually see - while two EA positions were open.
#
# Resolve the directory that actually HOLDS the terminal's logs rather than trusting
# whichever profile happens to be running this.
$TerminalHash = 'D0E8209F77C8CF37AD8BF550E51FF075'
function Resolve-Mt5DataDir($hash) {
    $cands = @()
    if ($env:APPDATA) { $cands += (Join-Path $env:APPDATA "MetaQuotes\Terminal\$hash") }
    foreach ($u in (Get-ChildItem 'C:\Users' -Directory -EA SilentlyContinue)) {
        $cands += (Join-Path $u.FullName "AppData\Roaming\MetaQuotes\Terminal\$hash")
    }
    $best = $null; $bestAt = [datetime]::MinValue
    foreach ($c in ($cands | Select-Object -Unique)) {
        $logs = @(Get-ChildItem (Join-Path $c 'MQL5\Logs\2*.log') -EA SilentlyContinue)
        if (-not $logs) { continue }
        $at = ($logs | Sort-Object LastWriteTime -Descending)[0].LastWriteTime
        if ($at -gt $bestAt) { $bestAt = $at; $best = $c }
    }
    # Falling back to APPDATA preserves the old behaviour when nothing is readable, so
    # this can only ever ADD visibility, never take any away.
    if ($best) { return $best }
    if ($env:APPDATA) { return (Join-Path $env:APPDATA "MetaQuotes\Terminal\$hash") }
    return $null
}
$DataDir   = Resolve-Mt5DataDir $TerminalHash
# THIS FILE IS VPS-OWNED, DELIBERATELY, AND THAT IS WHY THIS PATH IS NOT $Root.
#
# tasks/pull_vps_status.ps1:26 copies the VPS's mt5-runtime-status.json DOWN onto the
# laptop every 10 minutes: the laptop dashboard is meant to show the terminal on the box
# that trades 24/7, not its own. Deriving this from $Root the way the two paths above are
# derived puts a SECOND writer on that filename, and the laptop panel then alternates
# between two machines' terminals depending on which job ran last. Measured 2026-09-07 -
# the laptop's copy held host=VMI3465345, account=11581419, EA v355, which is correct and
# intended, not drift.
#
# So the literal stays, and on the laptop this write lands outside the live repo and does
# nothing, which is the status quo and is harmless. If the laptop should ever publish its
# OWN MT5 state that needs a distinct filename and a reader, not a change here.
$StatusOut = 'C:\ai-trading-dashboard\dashboard\mt5-runtime-status.json'
$LogFile   = "$Root\tasks\logs\mt5_ensure_running.txt"

if (-not (Test-Path "$Root\tasks\logs")) { New-Item -ItemType Directory -Force "$Root\tasks\logs" | Out-Null }
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Encoding utf8 $LogFile }

# LOG AT START, NOT ONLY AT THE END. This script logged only after it had done its work, so a
# run that STARTED and died half way looked exactly like a run that never started - and on
# 2026-09-06 the scheduled task reported LastTaskResult=0 with NumberOfMissedRuns=0 for an
# hour while writing nothing at all. With no start line there was no way to tell whether Task
# Scheduler was launching it. This line costs nothing and settles that question forever.
Log ("START  pid=$PID  user=$env:USERNAME  session=" +
     (Get-Process -Id $PID).SessionId + "  interactive=$([Environment]::UserInteractive)")

$action = 'already running'
$proc = Get-Process -Name terminal64 -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $proc) {
    # GRACE DELAY before concluding MT5 is down.
    #
    # On 2026-09-04 this task fired during the 27-second gap while MT5 restarted itself for
    # the 6090 -> 6140 auto-update, saw no process, and started a SECOND terminal 8 seconds
    # after the first came back. Two terminals on one data folder is a config-corruption
    # risk and was caused entirely by this check being too eager. A terminal that is merely
    # restarting reappears within a minute; one that is genuinely down stays down, so the
    # only cost of waiting is a slightly later recovery.
    Start-Sleep -Seconds 60
    $proc = Get-Process -Name terminal64 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) { Log 'MT5 reappeared during the grace delay (it was restarting) - not starting another.'; $action = 'already running' }
}

if (-not $proc) {
    if (Test-Path $TermExe) {
        # START WITH THE CRT CONFIG so the EA is attached on every start.
        #
        # This terminal has NO `profiles` directory, so MT5 has nothing to restore a chart
        # or an attached expert from and every start comes up bare. That is why
        # EA_CRT_AMD_Dashboard vanished on 2026-09-04 and could not return on its own: it
        # was displaced at 14:22 when the charts were replaced by TK_SMART_ENTRY, and
        # nothing re-attached it. This script kept the TERMINAL alive and only ever
        # REPORTED eaAttached -- monitoring with no recovery, which is how it stayed down
        # for 17 hours while every check said MT5 was healthy.
        #
        # NO NEW RESTART IS INTRODUCED. This changes only HOW a start that was already
        # going to happen behaves. If the ini is missing it falls back to the bare start,
        # which is exactly the previous behaviour, so a lost config can never stop MT5
        # coming back. This script still never kills anything.
        if (Test-Path $CrtIni) {
            Start-Process -FilePath $TermExe -ArgumentList "`"$CrtIni`""
            Log "MT5 was NOT running - started it WITH the CRT config (EA attaches on startup)."
        } else {
            Start-Process -FilePath $TermExe
            Log "MT5 was NOT running - started it BARE: $CrtIni missing, so NO EA will attach."
        }
        Start-Sleep -Seconds 20
        $all = @(Get-Process -Name terminal64 -ErrorAction SilentlyContinue)
        $proc = $all | Select-Object -First 1
        $action = if ($proc) { 'started' } else { 'start FAILED' }
        # Never silently leave two behind: report it loudly rather than kill one, since
        # either instance may be the one holding the charts and the EA.
        if ($all.Count -gt 1) {
            $action = 'started BUT ' + $all.Count + ' terminals now running'
            Log ('WARNING: ' + $all.Count + ' terminal64 processes: ' + (($all | ForEach-Object { $_.Id }) -join ', '))
        }
    } else {
        $action = 'terminal64.exe missing'
        Log "Cannot start MT5: $TermExe not found."
    }
}

# ---- everything below is read-only reporting -------------------------------------------
# The point of this file is that you can SEE the answer without opening a terminal. Each
# field is stated as unknown rather than guessed when it cannot be read: "cannot tell" and
# "it is fine" must never look the same.

$build = (Get-Item $TermExe).VersionInfo.FileVersion

# SAME SHAPE AS THE EA-ATTACH BUG BELOW, AND IT BIT THE SAME WAY. This read ONLY the
# newest terminal log, but the terminal logs "authorized on" ONCE, at login. This one
# authorized 2026-09-06 17:21, so on 2026-09-07 the newest log held no such line and
# `account` rendered as "-" on the dashboard - not because the account was unknown, but
# because the check looked in a one-day window for an event that happens at startup.
# Scan back through the retained logs, exactly as the EA scan does.
$account = $null
$termLogs = @(Get-ChildItem "$DataDir\logs\2*.log" -EA SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 21)
foreach ($tl in $termLogs) {
    $line = (Get-Content $tl.FullName -Encoding Unicode -EA SilentlyContinue | Select-String "authorized on" | Select-Object -Last 1).Line
    if ($line -match "'(\d{6,9})': authorized on ([\w\- ]+)") {
        $account = "$($Matches[1]) @ $($Matches[2])".Trim()
        break
    }
}
# Still nothing? config\common.ini holds the login this terminal is configured for. That
# is weaker evidence than a live authorization - it says which account it WOULD use, not
# which it is on - so it is labelled rather than passed off as the same thing.
if (-not $account) {
    $cfg = Get-Content "$DataDir\config\common.ini" -Encoding Unicode -EA SilentlyContinue
    if ($cfg) {
        $lg = ($cfg | Select-String '^Login=(\d{6,9})')
        $sv = ($cfg | Select-String '^Server=(.+)$')
        if ($lg) {
            $account = $lg.Matches[0].Groups[1].Value
            if ($sv) { $account += ' @ ' + $sv.Matches[0].Groups[1].Value.Trim() }
            $account += ' (from config, no authorization line in the retained logs)'
        }
    }
}

# Algo trading permission for experts. Trade=1 is "allow automated trading" in Options.
$algo = $null
$common = Get-Content "$DataDir\config\common.ini" -Encoding Unicode
if ($common) { $m = $common | Select-String '^Trade=(\d)'; if ($m) { $algo = [int]$m.Matches[0].Groups[1].Value } }

# Is the chart EA actually attached? REWRITTEN 2026-09-06.
#
# The old test read ONLY the newest log and matched any line containing CRT_AMD, so a
# single line from 00:05 reported the EA attached until 23:59 -- and then flipped to
# false at midnight when the log rolled, which reads exactly like the EA stopping
# overnight. On 2026-09-06 that is precisely what it showed, and nothing had changed.
#
# THE EA LOGS ONCE, AT ATTACH, AND IS THEN SILENT. Measured: 09-04 14:10:31 and
# 14:11:49, 09-05 08:45:44, and nothing else -- no heartbeat, nothing in MQL5\Files. So
# "no line today" carries NO information either way, and a bare true or false here is a
# guess wearing the costume of a measurement. This file's own header says "cannot tell"
# and "it is fine" must never look the same; eaAttached = [bool]$eaName broke that rule.
#
# WHAT CAN HONESTLY BE INFERRED: whether the last attach happened in THIS terminal
# session. crt_start.ini attaches the EA at startup, so an attach at or after
# mt5StartedAt means this session came up with it on the chart. It could still have been
# removed by hand afterwards -- that leaves no log line -- so the residual uncertainty is
# NAMED in eaAttachBasis rather than hidden behind a boolean.
#
# ROOT CAUSE, REPORTED NOT ASSUMED: this terminal has no profiles directory, so MT5 has
# nothing to restore charts from and cannot hold TWO EAs across a restart. That is why
# EA_CRT_AMD and TK_SMART_ENTRY keep displacing each other.
$eaName = $null; $sentry = $null; $sentryAt = $null
$eaAttachAt = $null; $eaAttachAgeH = $null
$eaBasis = 'no CRT_AMD attach line in the retained logs'
$expLogs = @(Get-ChildItem "$DataDir\MQL5\Logs\2*.log" -EA SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 21)
foreach ($lf in $expLogs) {
    $hits = Get-Content $lf.FullName -Encoding Unicode -EA SilentlyContinue | Select-String 'CRT_AMD'
    if (-not $hits) { continue }
    $last = $hits[-1].Line
    $sentry = $last.Trim()
    $sentryAt = $lf.Name.Substring(0,8)
    if ($last -match '\s(\d{2}):(\d{2}):(\d{2})\.\d+\s') {
        try {
            $day = [datetime]::ParseExact($sentryAt,'yyyyMMdd',$null)
            $eaAttachAt = $day.AddHours([int]$Matches[1]).AddMinutes([int]$Matches[2]).AddSeconds([int]$Matches[3])
            $eaAttachAgeH = [math]::Round(((Get-Date) - $eaAttachAt).TotalHours, 1)
        } catch { }
    }
    if ($last -match '(EA_CRT_AMD_Dashboard[_A-Za-z0-9]*)\s*\(([A-Z]+),([A-Z0-9]+)\)') {
        $eaName = "$($Matches[1]) ($($Matches[2]),$($Matches[3]))"
    }
    break
}

# Attached in THIS session, or merely attached at some point in the past?
#
# NO READABLE LOG IS "CANNOT TELL", NOT "NOT ATTACHED". This file's own header already
# says "cannot tell" and "it is fine" must never look the same; the inverse matters just
# as much, because a false red is a monitor lying too. If zero expert logs were visible
# the scan learned NOTHING, so eaAttached stays $null and the basis names the directory
# it actually looked in.
$eaAttachedNow = $false
if ($expLogs.Count -eq 0) {
    $eaAttachedNow = $null
    $eaBasis = 'could not read ANY expert log under ' + $DataDir + ' - cannot tell whether the EA is attached'
}
if ($eaName -and $eaAttachAt -and $proc) {
    if ($eaAttachAt -ge $proc.StartTime.AddMinutes(-2)) {
        $eaAttachedNow = $true
        $eaBasis = 'attached during THIS terminal session (attach ' + $eaAttachAt.ToString('yyyy-MM-dd HH:mm:ss') + ', terminal started ' + $proc.StartTime.ToString('yyyy-MM-dd HH:mm:ss') + '). It logs only at attach, so a later manual removal would leave no trace.'
    } else {
        $eaBasis = 'last attach ' + $eaAttachAt.ToString('yyyy-MM-dd HH:mm:ss') + ' PREDATES this terminal session (started ' + $proc.StartTime.ToString('yyyy-MM-dd HH:mm:ss') + ') - this session never attached it'
    }
}
$profilesDir = Test-Path (Join-Path $DataDir 'profiles')
$status = [ordered]@{
    checkedAt         = (Get-Date).ToUniversalTime().ToString('o')
    host              = $env:COMPUTERNAME
    action            = $action
    mt5Running        = [bool]$proc
    pid               = if ($proc) { $proc.Id } else { $null }
    mt5StartedAt      = if ($proc) { $proc.StartTime.ToString('o') } else { $null }
    mt5UptimeHours    = if ($proc) { [math]::Round(((Get-Date) - $proc.StartTime).TotalHours, 1) } else { $null }
    terminalBuild     = $build
    account           = $account
    algoTradingAllowed = $algo
    eaAttached        = $eaAttachedNow
    # WHY it says that, including the part that cannot be known.
    eaAttachBasis     = $eaBasis
    eaLastAttachAt    = if ($eaAttachAt) { $eaAttachAt.ToUniversalTime().ToString('o') } else { $null }
    eaLastAttachAgeH  = $eaAttachAgeH
    # ROOT CAUSE of the EA/TK displacement loop: no profile means no chart survives a
    # restart, so the terminal only ever returns with whatever the ini attaches.
    profilesDirPresent = $profilesDir
    eaName            = $eaName
    # TRAIL OFF in the sentry line is the proof the winning config is live. Absent means
    # the trailing stop is on, which measured -551 GBP over 13 months of real ticks.
    # READS THE TRAIL FROM BOTH WORDINGS, AND THIS IS NOT OPTIONAL.
    # v3.55 listed trail-off as a DRIFT, so the literal "TRAIL OFF" meant off. v3.56 states
    # it outright as "TRAIL:OFF" / "TRAIL:ON" - and the moment that shipped, this line stopped
    # matching and published eaTrailOff=$false for a correctly configured EA, which the panel
    # renders as "Trailing stop: ON - losing". A false alarm produced BY the fix.
    # The v3.55 inversion is handled too: on that build "CONFIG: VALIDATED" can only print
    # when the trail is ON, so it is $false, not $true.
    eaTrailOff        = if ($sentry) {
                            if     ($sentry -match 'TRAIL:OFF')        { $true }
                            elseif ($sentry -match 'TRAIL:ON')         { $false }
                            elseif ($sentry -match 'TRAIL OFF')        { $true }
                            elseif ($sentry -match 'CONFIG: VALIDATED'){ $false }
                            else { $null }
                        } else { $null }
    eaFixedLot        = if ($sentry) { $sentry -match 'FIXEDLOT' } else { $null }
    lastSentryLine    = $sentry
    lastSentryLogDay  = $sentryAt
    osLastBoot        = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
}

$json = $status | ConvertTo-Json -Depth 4
$tmp = "$StatusOut.tmp"
# NO BOM. Out-File -Encoding utf8 on Windows PowerShell 5.1 writes a UTF-8 BOM, which makes
# the file unparseable by json.load and is the exact failure CLAUDE.md already records for
# strategy_settings.json ("it emits a UTF-8 BOM and silently reset the VPS to defaults").
# WriteAllText with UTF8Encoding($false) is the form that repo mandates.
[System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -Force $tmp $StatusOut      # atomic: a reader never sees a half-written file

Log ("{0} | mt5={1} pid={2} ea={3} trailOff={4} algo={5}" -f `
     $action, $status.mt5Running, $status.pid, $status.eaName, $status.eaTrailOff, $status.algoTradingAllowed)
$json
