# ============================================================================
#  lab_drain.ps1 - the 24/7 lab cycle: GENERATE -> DRAIN -> PROMOTE
#
#  Kept as ONE task rather than three. Three tasks would each carry their own
#  IgnoreNew guard but nothing would stop a generate overlapping a drain, and two
#  drains running together would execute one queued job twice and register it as two
#  distinct runs - corrupting the trial count the entire lab rests on. One task, one
#  instance, strict order.
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
    [int]$Max = 50,
    # How many NEW candidates to propose per cycle. Small on purpose: every cell is
    # a trial that raises the deflation bar for its whole family, so searching fast
    # makes the bar harder, not the answer better.
    [int]$GenMax = 8,
    [string]$NodeExe = ''
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

# RESOLVING NODE IS THE HEADLESS TRAP, not an afterthought.
#
# Under a SYSTEM / S4U principal there is no user PATH, so a bare `node` resolves to
# nothing and the task fails EVERY tick while reporting a tidy exit code. This project
# has already been bitten by "a PATH fix only reaches processes started after it".
# So: an explicitly passed path wins, then PATH, then the usual install locations, and
# the one actually used is written to the log so a failure names itself.
function Resolve-Node([string]$explicit) {
    if ($explicit -and (Test-Path $explicit)) { return $explicit }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # Forward slashes deliberately: PowerShell resolves them, and every backslash in
    # a Windows path is one more chance for a layer of escaping to eat it. The first
    # version of this list was written with backslashes and arrived corrupted, with
    # the \n of \nodejs turned into a literal newline. It still passed its test,
    # because node was on PATH and this branch never ran - which is precisely the
    # headless case it exists for.
    foreach ($c in @(
        "$env:ProgramFiles/nodejs/node.exe",
        "${env:ProgramFiles(x86)}/nodejs/node.exe",
        "$env:LOCALAPPDATA/Programs/nodejs/node.exe",
        "C:/Program Files/nodejs/node.exe")) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}
try {
    Set-Location $Proj

    $node = Resolve-Node $NodeExe
    if (-not $node) {
        Write-Log 'ERROR: node could not be resolved (no PATH under a service principal, and no known install location). Nothing ran.'
        exit 0
    }

    # Nothing queued is the NORMAL case and must stay quiet in the log, or the
    # signal drowns. One line, not a report.
    $statusJson = Join-Path $Proj 'tasks\analysis\lab\_queue.jsonl'
    if (-not (Test-Path $statusJson)) {
        Write-Log 'tick: no queue file yet'
        exit 0
    }

    # ---- 1. GENERATE ------------------------------------------------------
    # Propose candidates nobody has tried. It refuses to pile up on its own when
    # the queue is already deep, so a slow cycle cannot build a backlog nobody reads.
    $gen = & $node (Join-Path $Proj 'tasks/lab_generate.cjs') '--max' $GenMax 2>&1
    $genText = ($gen | Out-String).Trim()
    if ($genText -match 'fully explored') {
        Write-Log 'generate: declared space fully explored - nothing new'
    } elseif ($genText -match 'already pending') {
        Write-Log 'generate: queue still deep, generated nothing'
    } else {
        $q = ([regex]::Matches($genText, '(?m)^\s*queued')).Count
        if ($q -gt 0) { Write-Log ("generate: queued {0}" -f $q) }
    }

    # ---- 2. DRAIN ---------------------------------------------------------
    $out = & $node (Join-Path $Proj 'tasks/lab_queue.cjs') '--drain' '--max' $Max 2>&1
    $code = $LASTEXITCODE

    $text = ($out | Out-String).Trim()
    $ran = 0
    if ($text -match 'ran:\s*(\d+)') { $ran = [int]$Matches[1] }

    if ($ran -gt 0) {
        Write-Log ("drained {0} (exit {1}) via {2}" -f $ran, $code, $node)
        foreach ($l in ($text -split "`n")) {
            $t = $l.Trim()
            if ($t -match '^(DONE|FAILED)') { Write-Log ('  ' + $t) }
        }
    } else {
        Write-Log ("tick: nothing pending (exit {0})" -f $code)
    }

    # ---- 3. PROMOTE -------------------------------------------------------
    # Judges finished assessments against a pre-registered bar and, for anything
    # that clears it, STAGES the candidate and sends one Telegram. It stages; it
    # never promotes. No gate, threshold, size or stop is reachable from it, and
    # each candidate is notified once ever, keyed by its spec hash.
    $prom = & $node (Join-Path $Proj 'tasks/lab_promote.cjs') 2>&1
    $promText = ($prom | Out-String).Trim()
    if ($promText -match 'checked\s+(\d+).*?(\d+) cleared the bar,\s*(\d+) notified') {
        $clearedN = [int]$Matches[2]; $notifiedN = [int]$Matches[3]
        # Silent unless something actually cleared. A line every 15 minutes saying
        # 'nothing cleared' is how a log stops being read.
        if ($clearedN -gt 0 -or $notifiedN -gt 0) {
            Write-Log ("promote: {0} cleared the bar, {1} notified" -f $clearedN, $notifiedN)
            foreach ($l in ($promText -split "`n")) {
                $t = $l.Trim()
                if ($t -match '^STAGED') { Write-Log ('  ' + $t) }
            }
        }
    } else {
        Write-Log 'promote: could not parse its output - investigate'
    }

    exit 0
}
catch {
    # Recorded, never rethrown. See the header: an alarm nobody can act on is worse
    # than no alarm, and this job failing does not affect trading in any way.
    Write-Log ('ERROR: ' + $_.Exception.Message)
    exit 0
}
