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
# `requires` names a file without which the step CANNOT work on this box. tasks/vps_parity.cjs
# hardcodes HOST=169.58.74.133 and KEY=C:\Users\User\.ssh\contabo_smartentry (lines 47-49):
# it is a LAPTOP-side tool that probes the VPS. Run ON the VPS it SSHes to itself with a key
# path that does not exist there, so it failed "exit 1 after 1s" every single night since the
# job was created - an action item that could never clear, in a list whose whole worth is that
# a red line means something. Skipped with a stated reason instead of failed.
$jobs = @(
    @{ name = 'engine parity';        exe = 'node'; args = @('tasks/vps_parity.cjs','--emit'); requires = 'C:\Users\User\.ssh\contabo_smartentry' },
    @{ name = 'time heat map';        exe = 'node'; args = @('tasks/time_heatmap.cjs') },
    @{ name = 'session walk-forward'; exe = 'node'; args = @('tasks/session_walkforward.cjs') },
    @{ name = 'setup walk-forward';   exe = 'node'; args = @('tasks/session_walkforward.cjs','--by','setup') },
    @{ name = 'regime cross-tab';     exe = 'node'; args = @('tasks/regime_xtab.cjs') }
)

# A FAILED line that does not say WHY costs the same as no line at all. Every step's output
# used to go to $null on the reasoning that this file should not become a second copy of five
# reports nobody reads - right for a step that SUCCEEDS, and exactly wrong for one that fails,
# because the harness may die before writing its own log. Five steps failed here nightly from
# 2026-08-13 and not one recorded a cause. Tail on failure only, so the original intent holds.
$FAILURE_TAIL_LINES = 6
function Say-Failure($name, $verdict, $captured) {
    Say ("  FAILED  {0,-22} {1}" -f $name, $verdict)
    if ($captured) {
        $lines = @($captured | ForEach-Object { $_.ToString() } | Where-Object { $_.Trim() -ne '' })
        if ($lines.Count) {
            foreach ($l in ($lines | Select-Object -Last $FAILURE_TAIL_LINES)) {
                Say ("            | " + $l.Trim())
            }
        } else { Say "            | (the step produced no output at all)" }
    } else { Say "            | (no output captured)" }
}

# BEFORE the harnesses, and it is not one of them: do the doctor's own checks still fire?
# Placed after Say-Failure rather than at the top of the file because PowerShell resolves
# functions at runtime, so calling it above its definition fails with "not recognized".
#
# The daily job already runs this suite at 07:30, so why again. Because one run a day means a
# doctor that breaks at 08:00 goes unreported for 24 hours, and this fleet's whole history is
# silent failures behind green checks. Two runs about twelve hours apart halves that window,
# and this job is the right second home: deterministic, no AI, no tokens, so it still runs on
# the day the claude ceiling closes.
#
# Writes the SAME per-run artifact the daily job writes, because checkDoctorSelftest() in
# tasks/doctor.cjs reads exactly one file. A second path would be a second source of truth
# and one of them would go unread. Whichever job ran last is the one that counts.
#
# Set-Content is given -Encoding utf8 explicitly: it defaults to the system ANSI codepage on
# PowerShell 5.1, which is the same family of bug that mojibaked six dashboard pages.
#
# Deliberately does NOT increment $failed, same as the reschedule step further down. This
# script's exit code means "the evidence did not refresh"; a broken self-test is a different
# statement and surfaces as a doctor AMBER, which is a finding someone can actually read.
$selftestOut = Join-Path $proj 'tasks\logs\doctor_selftest_last.txt'
$t0 = Get-Date
try {
    # 2>&1 for the same reason as every step below, and the verdict reads $LASTEXITCODE and
    # never $?, because in PS 5.1 that redirect drives $? to False even on a clean exit.
    $out  = & node 'tasks/doctor_selftest.cjs' 2>&1
    $code = $LASTEXITCODE
    $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    Set-Content -Path $selftestOut -Value $out -Encoding utf8
    # The marker goes on AFTER the run, so its absence tells the doctor this died partway.
    Add-Content -Path $selftestOut -Value ("[selftest exit {0}]" -f $code) -Encoding utf8
    if ($code -eq 0) { Say ("  OK      {0,-22} {1}s" -f 'doctor self-test', $secs) }
    else {
        Say-Failure 'doctor self-test' ("exit {0} after {1}s - the doctor cannot verify itself, so a clean report from it is not evidence" -f $code, $secs) $out
    }
} catch {
    Say ("  WARN    doctor self-test did not run: {0}" -f $_.Exception.Message)
}

$failed = 0
$skipped = 0
foreach ($j in $jobs) {
    if ($j.requires -and -not (Test-Path $j.requires)) {
        Say ("  SKIPPED {0,-22} needs {1}, which is absent on this box" -f $j.name, $j.requires)
        $skipped++
        continue
    }
    $t0 = Get-Date
    try {
        # 2>&1 is what puts the harness's stderr into $out, which is where every one of these
        # reports its real error. Note it also drives $? to False even on a clean exit in PS
        # 5.1 - measured on this box - which is exactly why the verdict below reads
        # $LASTEXITCODE and never $?.
        $out  = & $j.exe $j.args 2>&1
        $code = $LASTEXITCODE
        $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
        if ($code -eq 0) { Say ("  OK      {0,-22} {1}s" -f $j.name, $secs) }
        else { Say-Failure $j.name ("exit {0} after {1}s" -f $code, $secs) $out; $failed++ }
    } catch {
        Say-Failure $j.name $_.Exception.Message $null; $failed++
    }
}

# The deep plan LAST, so it reads the artifacts the harnesses above just regenerated
# rather than yesterday's. It also sends the Telegram message and writes the pre-open
# artifact the dashboard panel reads.
$t0 = Get-Date
try {
    # Same capture as the harnesses above. deep_plan.cjs exits 2 from a single catch that
    # prints "deep-plan: <message>" to stderr, so the message IS the diagnosis - and it was
    # being discarded, which is why three nights of "FAILED deep plan exit 2" say nothing
    # about what threw. It also runs clean by hand, so the cause is specific to this hour.
    $out  = & node 'tasks/deep_plan.cjs' 2>&1
    $code = $LASTEXITCODE
    $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    if ($code -eq 0) { Say ("  OK      {0,-22} {1}s" -f 'deep plan', $secs) }
    else { Say-Failure 'deep plan' ("exit {0} after {1}s" -f $code, $secs) $out; $failed++ }
} catch { Say-Failure 'deep plan' $_.Exception.Message $null; $failed++ }

# Then move tomorrow's pre-open trigger out of any blackout the fresh plan found. This
# is the step that stops the pre-open job firing into the hour it exists to prepare for.
# Its own failure mode is to leave the existing trigger alone, so a failure here delays
# the plan rather than cancelling it - which is why it does not increment $failed.
try {
    $null = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $proj 'tasks\reschedule_preopen.ps1') 2>&1
    if ($LASTEXITCODE -eq 0) { Say "  OK      reschedule pre-open" }
    else { Say "  WARN    reschedule pre-open left the existing trigger in place (see reschedule_preopen.txt)" }
} catch { Say ("  WARN    reschedule pre-open: {0}" -f $_.Exception.Message) }

# The daily P&L review, if the interpreter is present. Kept separate from the harnesses
# above because it reports on TRADES rather than measuring the engine, and its absence
# is not a failure of the analysis.
$eod = Join-Path $proj 'eod_review.py'
if (Test-Path $eod) {
    try { $null = & python $eod 2>&1; Say "  OK      eod review" }
    catch { Say ("  skipped eod review: {0}" -f $_.Exception.Message) }
}

Say ("=== POST-CLOSE ANALYSIS DONE - {0} failed, {1} skipped ===" -f $failed, $skipped)

# Exit code so a scheduled task shows red when the evidence did not refresh. A silent
# failure here means tomorrow's pre-open plan quietly reads yesterday's numbers.
exit $(if ($failed -gt 0) { 1 } else { 0 })
