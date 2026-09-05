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

$Root      = 'C:\ai-trading-dashboard'
$TermExe   = 'C:\Program Files\MetaTrader 5\terminal64.exe'
$CrtIni    = 'C:\ai-trading-dashboard\tasks\crt_start.ini'
$DataDir   = "$env:APPDATA\MetaQuotes\Terminal\D0E8209F77C8CF37AD8BF550E51FF075"
$StatusOut = "$Root\dashboard\mt5-runtime-status.json"
$LogFile   = "$Root\tasks\logs\mt5_ensure_running.txt"

if (-not (Test-Path "$Root\tasks\logs")) { New-Item -ItemType Directory -Force "$Root\tasks\logs" | Out-Null }
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Encoding utf8 $LogFile }

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

$account = $null
$termLog = Get-ChildItem "$DataDir\logs\2*.log" | Sort-Object Name -Descending | Select-Object -First 1
if ($termLog) {
    $line = (Get-Content $termLog.FullName -Encoding Unicode | Select-String "authorized on" | Select-Object -Last 1).Line
    if ($line -match "'(\d{6,9})': authorized on ([\w\- ]+)") { $account = "$($Matches[1]) @ $($Matches[2])".Trim() }
}

# Algo trading permission for experts. Trade=1 is "allow automated trading" in Options.
$algo = $null
$common = Get-Content "$DataDir\config\common.ini" -Encoding Unicode
if ($common) { $m = $common | Select-String '^Trade=(\d)'; if ($m) { $algo = [int]$m.Matches[0].Groups[1].Value } }

# Is the chart EA actually attached and what config did it report at attach? The EA's own
# CONFIG SENTRY line is the only authoritative view of its LIVE inputs.
$eaName = $null; $sentry = $null; $sentryAt = $null
$expLog = Get-ChildItem "$DataDir\MQL5\Logs\2*.log" | Sort-Object Name -Descending | Select-Object -First 1
if ($expLog) {
    $hits = Get-Content $expLog.FullName -Encoding Unicode | Select-String 'CRT_AMD'
    if ($hits) {
        $last = $hits[-1].Line
        $sentry = $last.Trim()
        $sentryAt = $expLog.Name.Substring(0,8)
        if ($last -match '(EA_CRT_AMD_Dashboard[_A-Za-z0-9]*)\s*\(([A-Z]+),([A-Z0-9]+)\)') {
            $eaName = "$($Matches[1]) ($($Matches[2]),$($Matches[3]))"
        }
    }
}

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
    eaAttached        = [bool]$eaName
    eaName            = $eaName
    # TRAIL OFF in the sentry line is the proof the winning config is live. Absent means
    # the trailing stop is on, which measured -551 GBP over 13 months of real ticks.
    eaTrailOff        = if ($sentry) { $sentry -match 'TRAIL OFF' } else { $null }
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
