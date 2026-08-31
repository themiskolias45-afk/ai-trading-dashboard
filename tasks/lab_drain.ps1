# ============================================================================
#  lab_drain.ps1 - run the queued backtests, out of band
# ============================================================================
#
#  What the scheduled task actually executes. It exists as its own file rather
#  than a long -Argument string so the work is readable, loggable, and can be run
#  by hand identically to the way the scheduler runs it.
#
#  WHY IT IS BOUNDED. This runs on a box that trades. One candidate is ~0.3s
#  today, but a queue is however long somebody made it, and a strategy added next
#  month may not be cheap. -Max caps the work per tick; the scheduled task ALSO
#  caps wall time, so two independent limits have to fail before this can matter.
#
#  IT TOUCHES NOTHING LIVE. lab_queue.cjs reads historical CSVs and writes
#  artifacts under tasks/analysis/lab. No gate, threshold, position size or stop
#  is reachable from it, and it never contacts the broker.
#
#  IT NEVER THROWS. A scheduled task that exits non-zero raises an alarm, and an
#  alarm for "the queue was empty" is noise that trains people to ignore the log.
#  Every failure is written to the log and the exit code stays 0 unless node
#  itself could not be started at all.
# ============================================================================

param(
    [int]$Max = 50
)

$ErrorActionPreference = 'Continue'
$Proj = Split-Path -Parent $PSScriptRoot
$Log  = Join-Path $Proj 'tasks\logs\lab_drain.txt'

if (-not (Test-Path (Split-Path -Parent $Log))) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $Log) | Out-Null
}

function Write-Log([string]$msg) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    # Append only. This log is a record of every tick and is never rewritten.
    Add-Content -LiteralPath $Log -Value $line -Encoding utf8
}

try {
    Set-Location $Proj

    # Nothing queued is the NORMAL case and must stay quiet in the log, or the
    # signal drowns. One line, not a report.
    $statusJson = Join-Path $Proj 'tasks\analysis\lab\_queue.jsonl'
    if (-not (Test-Path $statusJson)) {
        Write-Log 'tick: no queue file yet'
        exit 0
    }

    $out = & node (Join-Path $Proj 'tasks\lab_queue.cjs') '--drain' '--max' $Max 2>&1
    $code = $LASTEXITCODE

    $text = ($out | Out-String).Trim()
    $ran = 0
    if ($text -match 'ran:\s*(\d+)') { $ran = [int]$Matches[1] }

    if ($ran -gt 0) {
        Write-Log ("drained {0} (exit {1})" -f $ran, $code)
        foreach ($l in ($text -split "`n")) {
            $t = $l.Trim()
            if ($t -match '^(DONE|FAILED)') { Write-Log ('  ' + $t) }
        }
    } else {
        Write-Log ("tick: nothing pending (exit {0})" -f $code)
    }
    exit 0
}
catch {
    # Recorded, never rethrown. See the header: an alarm nobody can act on is worse
    # than no alarm, and this job failing does not affect trading in any way.
    Write-Log ('ERROR: ' + $_.Exception.Message)
    exit 0
}
