# Did the sleep fix hold?
#
#   powershell -File tasks\sleep_verify.ps1 -Baseline    # record today's numbers, once
#   powershell -File tasks\sleep_verify.ps1              # compare against the baseline
#
# ASCII only, deliberately: Windows PowerShell 5.1 reads a .ps1 as ANSI without a BOM, so
# one em-dash arrives as garbage and the whole script fails to parse.
#
# WHY THIS EXISTS
# The heartbeat log cannot answer this question. The tick AFTER a hole restarts everything
# before reporting, so the log reads healthy either side of a 33-hour outage. The only
# honest measure is the GAP, and the only source that cannot be fooled is the machine's
# own Power-Troubleshooter record of when it slept and what woke it.
#
# NOTE ON COUNTING: PowerShell evaluates $null -ne '' as TRUE. A first version of this
# count reported "40 of 40 timer wakes" - the exact opposite of the truth - because events
# missing WakeTimerOwner scored as timer wakes. Everything below casts to [string] first.

param([switch]$Baseline)

$ErrorActionPreference = 'Stop'
$proj     = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $proj 'tasks\sleep_baseline.json'

function Get-SleepStats {
    param([int]$MaxEvents = 200, [datetime]$Since = [datetime]::MinValue)
    $ev = Get-WinEvent -FilterHashtable @{
        LogName      = 'System'
        ProviderName = 'Microsoft-Windows-Power-Troubleshooter'
        Id           = 1
    } -MaxEvents $MaxEvents -ErrorAction SilentlyContinue

    $rows = foreach ($e in $ev) {
        $x = [xml]$e.ToXml(); $d = @{}
        $x.Event.EventData.Data | ForEach-Object { $d[$_.Name] = $_.'#text' }
        $sleep = [datetime]$d['SleepTime']
        if ($sleep -lt $Since) { continue }
        [pscustomobject]@{
            Sleep      = $sleep
            Wake       = [datetime]$d['WakeTime']
            Hours      = [math]::Round((([datetime]$d['WakeTime']) - $sleep).TotalHours, 2)
            SrcTypeNum = [string]$d['WakeSourceType']
            TimerOwner = [string]$d['WakeTimerOwner']
            HiberPages = [int]$d['HiberPagesWritten']
        }
    }
    $rows = @($rows | Sort-Object Sleep)
    if ($rows.Count -eq 0) {
        return [pscustomobject]@{ Episodes=0; SpanHours=0; AsleepHours=0; PercentAsleep=0; TimerWakes=0; Hibernated=0; LongestHours=0; First=$null; Last=$null }
    }
    $span   = ($rows[-1].Wake - $rows[0].Sleep).TotalHours
    $asleep = ($rows | Measure-Object Hours -Sum).Sum
    [pscustomobject]@{
        Episodes      = $rows.Count
        SpanHours     = [math]::Round($span, 1)
        AsleepHours   = [math]::Round($asleep, 1)
        PercentAsleep = if ($span -gt 0) { [math]::Round(100 * $asleep / $span, 1) } else { 0 }
        # Cast first. See the counting note at the top of this file.
        TimerWakes    = @($rows | Where-Object { $_.SrcTypeNum -ne '0' -or -not [string]::IsNullOrEmpty($_.TimerOwner) }).Count
        Hibernated    = @($rows | Where-Object { $_.HiberPages -gt 0 }).Count
        LongestHours  = ($rows | Measure-Object Hours -Maximum).Maximum
        First         = $rows[0].Sleep
        Last          = $rows[-1].Wake
    }
}

function Get-OverrideApplied {
    # powercfg /requestsoverride is readable unelevated; /requests and /waketimers are not.
    $out = (& powercfg /requestsoverride 2>&1) -join "`n"
    return ($out -match '(?im)^\s*node\.exe')
}

# THERE ARE TWO FIXES, AND THIS FILE ONLY KNEW ABOUT ONE.
# Option A is the elevated powercfg override above. Option B is tasks\stay_awake.ps1 -
# an unelevated SetThreadExecutionState holder registered as "SmartEntry Stay Awake",
# which is the fix actually installed on this box. Reporting "applied: NO" while B runs
# told the reader to apply an elevated override that had already been superseded, which
# is a stale instruction of exactly the kind this project keeps paying for.
#
# RUNNING IS THE TEST, not merely registered: the holder releases and exits if the server
# stops answering, and a Ready task holds nothing.
function Get-HolderApplied {
    try {
        $t = Get-ScheduledTask -TaskName 'SmartEntry Stay Awake' -ErrorAction Stop
        return ($t.State -eq 'Running')
    } catch {
        return $false
    }
}

function Get-SleepFixApplied {
    if (Get-OverrideApplied) { return 'A' }
    if (Get-HolderApplied)   { return 'B' }
    return $null
}

# WHEN the fix started running, which is not the same as when the baseline was recorded.
# The baseline here is 7 days old and the holder has been up for ~1 hour, so every sleep
# episode in the window happened BEFORE the fix existed - and judging the fix on them
# would print "applied but NOT holding" for a fix that has not yet had a night to hold.
# A verdict on a window that predates the change is not a measurement.
# Null for Option A: a powercfg override records no start time, so the baseline stands.
function Get-FixAppliedAt {
    param([string]$Which)
    if ($Which -ne 'B') { return $null }
    try {
        $i = Get-ScheduledTaskInfo -TaskName 'SmartEntry Stay Awake' -ErrorAction Stop
        if ($i.LastRunTime -and $i.LastRunTime -gt [datetime]'2000-01-01') { return $i.LastRunTime }
        return $null
    } catch { return $null }
}

# One clear night. Below this there is nothing to judge - this box sleeps in multi-hour
# episodes, so a one-hour window can be quiet for reasons that have nothing to do with
# the fix.
$MIN_HOURS_BEFORE_JUDGING = 24

if ($Baseline) {
    $s = Get-SleepStats
    $s | Add-Member -NotePropertyName RecordedAt -NotePropertyValue (Get-Date).ToString('o')
    $s | Add-Member -NotePropertyName OverrideApplied -NotePropertyValue (Get-OverrideApplied)
    $s | ConvertTo-Json | Set-Content -Path $statePath -Encoding utf8
    "BASELINE RECORDED -> $statePath"
    $s | Format-List | Out-String
    exit 0
}

if (-not (Test-Path $statePath)) {
    "No baseline. Run:  powershell -File tasks\sleep_verify.ps1 -Baseline"
    exit 2
}

$base  = Get-Content $statePath -Raw | ConvertFrom-Json
$since = [datetime]$base.RecordedAt
$now   = Get-SleepStats -Since $since
$appliedWhich = Get-SleepFixApplied
$applied      = [bool]$appliedWhich

"================================================================"
"  SLEEP VERIFY   baseline $([datetime]$base.RecordedAt | Get-Date -Format 'yyyy-MM-dd HH:mm')  ->  now"
"================================================================"
""
"  Sleep fix applied: {0}" -f $(if ($appliedWhich -eq 'A') { 'YES - Option A (powercfg requestsoverride node.exe)' } elseif ($appliedWhich -eq 'B') { 'YES - Option B (SmartEntry Stay Awake holder, running)' } else { 'NO' })
""
"  {0,-22} {1,12} {2,12}" -f '', 'BEFORE', 'SINCE'
"  {0,-22} {1,12} {2,12}" -f 'episodes',       $base.Episodes,      $now.Episodes
"  {0,-22} {1,12} {2,12}" -f 'hours asleep',   $base.AsleepHours,   $now.AsleepHours
"  {0,-22} {1,12} {2,12}" -f 'percent asleep', $base.PercentAsleep, $now.PercentAsleep
"  {0,-22} {1,12} {2,12}" -f 'longest episode', $base.LongestHours, $now.LongestHours
"  {0,-22} {1,12} {2,12}" -f 'timer wakes',    $base.TimerWakes,    $now.TimerWakes
"  {0,-22} {1,12} {2,12}" -f 'hibernated',     $base.Hibernated,    $now.Hibernated
""

if (-not $applied) {
    "  VERDICT: nothing was applied, so nothing should have changed."
    "           This is a correct null result, not a failed fix."
    "           See tasks\SLEEP-RUNBOOK.md, Option A."
    exit 0
}

# Too soon to judge, reported as its own verdict rather than folded into NOT FIXED.
$fixAt = Get-FixAppliedAt -Which $appliedWhich
if ($fixAt) {
    $heldHours = [math]::Round(((Get-Date) - $fixAt).TotalHours, 1)
    "  Fix running for ${heldHours}h (started $($fixAt.ToString('yyyy-MM-dd HH:mm')))"
    ""
    if ($heldHours -lt $MIN_HOURS_BEFORE_JUDGING) {
        "  VERDICT: TOO EARLY TO JUDGE. The fix has been up ${heldHours}h against a baseline"
        "           recorded $([math]::Round(((Get-Date) - $since).TotalHours,1))h ago, so the episodes counted above"
        "           mostly happened BEFORE it was applied. Re-check after ${MIN_HOURS_BEFORE_JUDGING}h."
        exit 0
    }
}

if ($now.Episodes -eq 0) {
    "  VERDICT: HELD. No sleep episodes at all since the baseline."
    exit 0
}
if ($now.PercentAsleep -lt ($base.PercentAsleep / 2)) {
    "  VERDICT: IMPROVED but not eliminated - still $($now.Episodes) episode(s), worst $($now.LongestHours)h."
    exit 0
}
"  VERDICT: NOT FIXED. Still $($now.PercentAsleep)% asleep across $($now.Episodes) episode(s)."
"           If Option A is applied and this is still red, the override is not holding -"
"           check 'powercfg /requests' (needs elevation) for who is releasing it."
exit 1
