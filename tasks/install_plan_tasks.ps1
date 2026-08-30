# Register the two scheduled jobs the daily plan was missing: the intraday monitor
# and the nightly review.
#
#   powershell -File tasks\install_plan_tasks.ps1              # dry run, changes nothing
#   powershell -File tasks\install_plan_tasks.ps1 -Execute
#
# ASCII ONLY, DELIBERATELY. Windows PowerShell 5.1 reads a .ps1 as ANSI unless the file
# carries a BOM, so a single em-dash in a double-quoted string arrives as garbage
# containing a quote character and the whole script fails to parse. Same rule as
# tasks\safe_server_restart.ps1.
#
# WHAT THESE DO
#   SmartEntry Plan Monitor  every 15 min  node tasks\plan_monitor.cjs --quiet
#       Reports CROSSINGS since the last pass: plan entry/stop/target crossed, a
#       confluence zone entered or left, the day passing 100% of its ATR range, and
#       confidence crossing the LIVE gate hours after a briefing that said WAIT.
#
#   SmartEntry Plan Review   nightly 23:40  node tasks\plan_review.cjs
#       Grades completed days against the bars the bridge already pushed and
#       accumulates tasks\analysis\plan-scorecard.json. Never grades today: a forming
#       bar has no final close.
#
# NEITHER WRITES A SIGNAL, A SETTING OR AN ORDER. Neither has any path to the engine.
# They cannot suppress a setup, which is the standing rule they were built under.
#
# PRINCIPAL IS CHOSEN PER BOX, ON EVIDENCE
#   The VPS is headless and nobody signs in. A task registered Interactive/AtLogOn
#   there CANNOT START - that is ERROR_NO_INTERACTIVE_SESSION (0x800710E0), which is
#   exactly why SmartEntryServer could not be restarted on demand and why every
#   logon-only job on that box was silently dead. So on the VPS these register as
#   SYSTEM with a boot trigger; on the laptop they match the existing
#   'SmartEntry Band Monitor' convention (current user, interactive).

param([switch]$Execute)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$mode = if ($Execute) { 'EXECUTE' } else { 'DRY RUN' }
Write-Host "install_plan_tasks [$mode]  project=$proj  box=$env:COMPUTERNAME"

# Refuse rather than register a task whose action does not exist. A scheduled job
# pointing at a missing script fails every run and reports it nowhere anyone reads.
$required = @('tasks\plan_monitor.cjs', 'tasks\plan_review.cjs', 'tasks\persist_bars.cjs', 'tasks\strategy_search.cjs')
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $proj $_)) })
if ($missing.Count -gt 0) {
    Write-Host "REFUSING: missing $($missing -join ', ')"
    exit 1
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'REFUSING: node.exe not on PATH'; exit 1 }
Write-Host "  node: $node"

# Headless box detection. The VPS hostname is vmi3465345; anything without an
# interactive desktop should take the SYSTEM path.
$isHeadless = ($env:COMPUTERNAME -like 'VMI*')
if ($isHeadless) {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Write-Host '  principal: SYSTEM / ServiceAccount  (headless box)'
} else {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Write-Host "  principal: $env:USERNAME / Interactive  (matches SmartEntry Band Monitor)"
}

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

function Install-PlanTask {
    param([string]$Name, [string]$Arguments, [object[]]$Triggers, [string]$Description)

    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    $verb = if ($existing) { 'UPDATE' } else { 'CREATE' }
    Write-Host ''
    Write-Host "  [$verb] $Name"
    Write-Host "     node.exe $Arguments"
    Write-Host "     wd $proj"
    foreach ($t in $Triggers) {
        $rep = if ($t.Repetition.Interval) { " rep=$($t.Repetition.Interval)" } else { '' }
        Write-Host "     trigger $($t.CimClass.CimClassName)$rep"
    }
    if (-not $Execute) { return }

    $action = New-ScheduledTaskAction -Execute $node -Argument $Arguments -WorkingDirectory $proj
    # Register-ScheduledTask -Force UPDATES in place. It does not delete history and it
    # does not touch any other task - re-running this script is safe.
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Triggers `
        -Principal $principal -Settings $settings -Description $Description -Force | Out-Null

    $check = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($check) { Write-Host "     registered, state=$($check.State)" }
    else { Write-Host '     FAILED: task not present after registration' }
}

# ---- Monitor: every 15 minutes, all day -------------------------------------
# All day rather than market hours only: BTC trades continuously, and the gate
# crossing this exists to catch does not respect a session.
$monitorTriggers = @()
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 15)
$monitorTriggers += $t
if ($isHeadless) { $monitorTriggers += (New-ScheduledTaskTrigger -AtStartup) }

Install-PlanTask -Name 'SmartEntry Plan Monitor' `
    -Arguments 'tasks\plan_monitor.cjs --quiet' `
    -Triggers $monitorTriggers `
    -Description 'Intraday plan monitor. Reports crossings since the last pass. Read-only: no signal, no setting, no order.'

# ---- Review: nightly ---------------------------------------------------------
# 23:40 local. It refuses to grade a date that is not yet complete, so the exact
# minute is not load-bearing; late enough that the day is done, early enough to be
# clear of the post-close jobs.
$reviewTriggers = @(New-ScheduledTaskTrigger -Daily -At '23:40')

Install-PlanTask -Name 'SmartEntry Plan Review' `
    -Arguments 'tasks\plan_review.cjs' `
    -Triggers $reviewTriggers `
    -Description 'Nightly plan grading into tasks\analysis\plan-scorecard.json. Read-only: no signal, no setting, no order.'

# ---- The doctor: diagnose BOTH boxes and apply the safe remedies --------------
#
# THE GAP THIS CLOSES, and it is the reason "auto-healing never fixes anything".
#
#   server/autohealer.js watches the DATA plane and can repair exactly two things:
#   a stale signal cache (>6h) and a stale price cache. Everything else it only
#   OBSERVES. Its healCount has been 0 for the life of the box, because the
#   30-minute signal cron refreshes long before 6h - so its one repair path is
#   effectively unreachable in normal operation. That is not a fault; it is a
#   data-plane watchdog and its own header says so.
#
#   tasks\doctor.cjs is the thing that covers the CONTROL plane - failing jobs,
#   undecided proposals, stale triggers, bridges not reporting - and every finding
#   carries the exact command that fixes it, with the safe subset executable via
#   --heal. It was never scheduled on either box. The only script that invoked it
#   ran it WITHOUT --heal. Its own header called the outcome in advance: "a remedy
#   nobody runs is a comment."
#
# WHY --heal IS SAFE HERE, on the doctor's own documented envelope: it runs only
# idempotent, non-destructive commands that already run on a schedule anyway. It
# never restarts a server, never touches a bridge, never changes a setting and
# never decides a proposal. Anything needing judgement is reported and left alone.
# Verified by running it: it healed the stale pre-open trigger and did nothing else.
#
# 07:10 local, ahead of the 07:30 daily check, so the daily agent reads a fleet the
# doctor has already tidied rather than one it is about to.
$doctorTriggers = @(New-ScheduledTaskTrigger -Daily -At '07:10')

Install-PlanTask -Name 'SmartEntry Doctor' `
    -Arguments 'tasks\doctor.cjs --heal' `
    -Triggers $doctorTriggers `
    -Description 'Diagnose both boxes and apply the SAFE remedies. Never restarts a server, never touches a bridge, never changes a setting, never decides a proposal.'

# ---- Robustness report: a generator with no scheduler ------------------------
#
# tasks\montecarlo_report.cjs writes tasks\analysis\montecarlo-latest.json, which is
# the entire content of the Robustness page. NOTHING RAN IT. The file on disk was
# five days old and the page rendered it with no date at all, so a stale report and a
# fresh one were indistinguishable on the page read to judge whether the system is
# sound. Same shape as the doctor: the tool existed, the trigger did not.
#
# WEEKLY, and Sunday 09:00 specifically. The harness replays three assets and
# bootstraps 4,000 paths - minutes of CPU on a box that trades - so it runs when Gold
# and SP500 are closed, and an hour ahead of the 10:00 Weekly Algo Review so that
# review reads a report generated today rather than last week's.
#
# The /api/robustness-report staleness threshold is 192h (8 days): this cadence plus a
# day of slack, so a healthy schedule never trips it and a MISSED run does.
$robustnessTriggers = @(New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '09:00')

Install-PlanTask -Name 'SmartEntry Robustness Report' `
    -Arguments 'tasks\montecarlo_report.cjs' `
    -Triggers $robustnessTriggers `
    -Description 'Weekly Monte-Carlo robustness report behind /report. Read-only replay over cached bars: no signal, no setting, no order.'

# ---- Deflated Sharpe: the search-bias correction --------------------------------
#
# Runs 20 minutes after the Monte-Carlo so it reads that run's fresh perTradeRSeries.
# Separate task rather than chained inside montecarlo_report.cjs, so a failure in one
# cannot take the other down and each can be run on its own.
#
# It answers the two questions the bootstrap cannot: how much of the result is luck in
# the SEARCH (Deflated Sharpe, correcting for every configuration ever tried), and how
# many trades are needed before the Sharpe is distinguishable from zero (MinTRL).
$sharpeTriggers = @(New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '09:20')

Install-PlanTask -Name 'SmartEntry Sharpe Robustness' `
    -Arguments 'tasks\sharpe_robustness.cjs --out tasks\analysis\sharpe-robustness.json' `
    -Triggers $sharpeTriggers `
    -Description 'Weekly PSR / Deflated Sharpe / MinTRL over the Monte-Carlo population. Read-only: no signal, no setting, no order.'

# ---- The data pipeline that makes the search worth running --------------------
#
# THE CHAIN THAT WAS BROKEN, and why "run the search 24/7" would have done nothing.
#
#   tasks\refresh_bars.cjs REFUSES whenever a position is open, because the MT5
#   exporter opens a SECOND MetaTrader5 client and that can drop the live bridge off
#   IPC. That refusal is correct. But positions have been open for 11+ days, so the
#   three trading CSVs had not grown since 2026-08-25.
#
#   The strategy searcher already passes --skip-if-bars-unchanged and exits without
#   running when the bar fingerprint is identical - which is exactly right, because
#   re-testing the SAME bars adds no evidence while still inflating the multiplicity
#   ledger and RAISING the bar every future candidate must clear.
#
#   So scheduling the search more often against stale bars would have made it skip more
#   often, not search more. The bottleneck was never the search. It was the data.
#
# tasks\persist_bars.cjs is the piece that fixes it: it appends from the bars the
# BRIDGE ALREADY PUSHED, read back out of the server's memory over HTTP. It opens no
# terminal and no second MT5 client, so it is safe with positions open - which is
# precisely why it can run when the exporter cannot. It appends only rows strictly newer
# than the last on disk, refuses any series that would leave a GAP, and never rewrites.
# Verified before scheduling: 393 rows across 9 files, 0 refused, every file still
# monotonic with no malformed rows.
$barTriggers = @()
$bt = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(7) `
        -RepetitionInterval (New-TimeSpan -Hours 1)
$barTriggers += $bt
if ($isHeadless) { $barTriggers += (New-ScheduledTaskTrigger -AtStartup) }

Install-PlanTask -Name 'SmartEntry Bar Keeper' `
    -Arguments 'tasks\persist_bars.cjs --execute' `
    -Triggers $barTriggers `
    -Description 'Appends bars the bridge already pushed. Safe with positions open: no second MT5 client. Append-only, refuses gaps, never rewrites.'

# ---- Continuous strategy search, gated on NEW DATA ----------------------------
#
# Every 6 hours, always with --skip-if-bars-unchanged. New D1 bars arrive about once a
# day, so in practice this does real work once and skips the rest - which is the only
# statistically sound way to "always be searching".
#
# WHY NOT MORE OFTEN. The searcher counts its own multiplicity: every candidate ever
# tested is appended to strategy_search_ledger.jsonl and the significance bar is
# DEFLATED by that count. The gate axis already carries 24 prior trials. Running against
# unchanged bars would raise the bar with no new evidence behind it, making a genuine
# improvement HARDER to detect - the same search-bias effect the Deflated Sharpe on the
# Robustness page measures. More searching against fixed data is worse, not better.
#
# It PROPOSES and never applies: it cannot write strategy_settings.json, the gate or any
# threshold. A human decides with tasks\ai_decide.cjs.
$searchTriggers = @()
$st = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(25) `
        -RepetitionInterval (New-TimeSpan -Hours 6)
$searchTriggers += $st
if ($isHeadless) { $searchTriggers += (New-ScheduledTaskTrigger -AtStartup) }

# REFUSE TO CREATE A SECOND SEARCHER. The VPS already carries SmartEntryStrategySearch
# (daily, via strategy_search_vps.bat, which passes the same --skip-if-bars-unchanged).
# Registering this one there gave the box TWO tasks running the same searcher into the
# SAME multiplicity ledger - which inflates the trial count twice as fast and RAISES the
# bar every future candidate must clear. That is the exact harm this schedule exists to
# avoid, so the installer now checks rather than trusting the operator to notice.
$existingSearch = @(Get-ScheduledTask | Where-Object {
    $_.TaskName -replace '\s','' -match 'StrategySearch' -and $_.TaskName -ne 'SmartEntry Strategy Search'
})
if ($existingSearch.Count -gt 0) {
    Write-Host ''
    Write-Host "  [SKIP] SmartEntry Strategy Search"
    Write-Host "         this box already runs a searcher: $($existingSearch[0].TaskName)"
    Write-Host "         two tasks would double-count the multiplicity ledger. Not registering."
} else {
Install-PlanTask -Name 'SmartEntry Strategy Search' `
    -Arguments 'tasks\strategy_search.cjs --axis all --skip-if-bars-unchanged' `
    -Triggers $searchTriggers `
    -Description 'Continuous strategy search, gated on new bars. Proposes, never applies: no gate, no threshold, no setting.'
}

Write-Host ''
if ($Execute) {
    Write-Host 'Done. Verify with:  Get-ScheduledTask -TaskName "SmartEntry Plan *"'
    Write-Host 'Run one now with:   Start-ScheduledTask -TaskName "SmartEntry Plan Monitor"'
} else {
    Write-Host 'DRY RUN. Nothing was registered. Re-run with -Execute.'
}
