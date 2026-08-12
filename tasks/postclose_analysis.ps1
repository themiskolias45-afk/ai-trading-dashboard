# POST-CLOSE DEEP ANALYSIS - run after the daily close, so the morning has fresh evidence.
#
#   powershell -File tasks\postclose_analysis.ps1
#
# ASCII ONLY: PowerShell 5.1 reads a .ps1 as ANSI without a BOM, so one em-dash in a
# double-quoted string arrives carrying a quote character and the file stops parsing.
#
# WHY THIS EXISTS AND WHY IT RUNS AT THIS HOUR
# Every scheduled job on this fleet was clock-scheduled with no relation to market
# hours: the morning agent at 05:00 UTC and the daily check at 05:30, both inside the
# ASIAN session, which is the one session measured NEGATIVE at the live gate. Nothing
# ran after the close and nothing ran before the NEW YORK open, which is the only
# session measured positive.
#
# This runs after the daily close and regenerates the measurement artifacts. The
# pre-open plan then READS those artifacts an hour before the NY open, so the plan is
# built on evidence refreshed a few hours earlier rather than on whatever was last
# computed by hand.
#
# DETERMINISTIC. No AI, no tokens, no network beyond the price feeds the harnesses
# already use. That matters: the claude subscription hit a WEEKLY ceiling today and
# every agent job on the VPS died at once. An analysis that cannot run on the day the
# ceiling closes is not a daily analysis.
#
# It changes nothing. Every harness here is read-only over bars and writes only to
# tasks/analysis and tasks/logs.

$ErrorActionPreference = 'Continue'   # one failed harness must not abort the rest
$proj = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $proj 'tasks\logs\postclose_analysis.txt'
function Say($msg) {
    # Stamped PER LINE, not once at the top. This run takes about seven minutes and the
    # first version timestamped every line with the start time, so the log showed five
    # sequential harnesses all completing in the same minute. A log that cannot show a
    # job getting slower is not a log.
    $line = "[" + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + "] $msg"
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding utf8
}

Say "=== POST-CLOSE ANALYSIS START ==="

# Ordered cheapest-first so a slow replay cannot starve the quick wins. Each entry is
# name, command, arguments.
$jobs = @(
    @{ name = 'engine parity';        exe = 'node'; args = @('tasks/vps_parity.cjs','--emit') },
    @{ name = 'time heat map';        exe = 'node'; args = @('tasks/time_heatmap.cjs') },
    @{ name = 'session walk-forward'; exe = 'node'; args = @('tasks/session_walkforward.cjs') },
    @{ name = 'setup walk-forward';   exe = 'node'; args = @('tasks/session_walkforward.cjs','--by','setup') },
    @{ name = 'regime cross-tab';     exe = 'node'; args = @('tasks/regime_xtab.cjs') }
)

$failed = 0
foreach ($j in $jobs) {
    $t0 = Get-Date
    try {
        # Output goes to the harness's own log; only the verdict is echoed here, or this
        # file becomes a second copy of five reports nobody reads.
        $null = & $j.exe $j.args 2>&1
        $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
        if ($LASTEXITCODE -eq 0) { Say ("  OK      {0,-22} {1}s" -f $j.name, $secs) }
        else { Say ("  FAILED  {0,-22} exit {1} after {2}s" -f $j.name, $LASTEXITCODE, $secs); $failed++ }
    } catch {
        Say ("  FAILED  {0,-22} {1}" -f $j.name, $_.Exception.Message); $failed++
    }
}

# The daily P&L review, if the interpreter is present. Kept separate from the harnesses
# above because it reports on TRADES rather than measuring the engine, and its absence
# is not a failure of the analysis.
$eod = Join-Path $proj 'eod_review.py'
if (Test-Path $eod) {
    try { $null = & python $eod 2>&1; Say "  OK      eod review" }
    catch { Say ("  skipped eod review: {0}" -f $_.Exception.Message) }
}

Say ("=== POST-CLOSE ANALYSIS DONE - {0} failed ===" -f $failed)

# Exit code so a scheduled task shows red when the evidence did not refresh. A silent
# failure here means tomorrow's pre-open plan quietly reads yesterday's numbers.
exit $(if ($failed -gt 0) { 1 } else { 0 })
