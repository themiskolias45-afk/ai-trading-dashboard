# THE MEDIC LOOP - runs the medic on a schedule so fleet health is never a once-a-day
# question, and raises its hand when something is unhandled.
#
#   powershell -ExecutionPolicy Bypass -File tasks\medic_loop.ps1
#   powershell -ExecutionPolicy Bypass -File tasks\medic_loop.ps1 -Install [-Hours 4]
#   powershell -ExecutionPolicy Bypass -File tasks\medic_loop.ps1 -Remove
#
# WHY A LOOP AT ALL
# tasks\doctor.cjs runs once a day on each box. On 2026-09-05 that meant two REDs sat red
# for seven days and a measurement harness produced nothing for two, all correctly
# detected and reported to nobody. Once a day is a report; this is a watch.
#
# EXIT CODES - the distinction that matters
#   0  the medic RAN. Findings may exist; findings are not a job failure.
#   1  the medic COULD NOT RUN. That is a real failure and the scheduler should show it.
# This is deliberate and it is the lesson from tasks\coverage_audit.ps1, whose exit 1 for
# "a RED finding" is read by the AI work ledger as FAILING - so a job doing its job
# perfectly looks broken, and you learn to skim past it. A finding and a breakage must
# never share an exit code.
#
# SAFETY - this script CHANGES NOTHING. It runs a read-only triage, writes its own log,
# and sends an alert. It does not heal, does not edit, does not restart, does not delete.
# Healing stays with tasks\doctor.cjs --heal, which vets and self-tests its own remedies.
# Nothing here touches a gate, a threshold, learning, a journal or an order path.
#
# THE LEDGER IS PER-BOX, AND THAT IS A KNOWN LIMIT.
# medic_ledger.jsonl lives beside the repo on whichever box wrote it, so an ack made on
# the laptop is not known to the VPS until the file is pulled. It is committed to git for
# exactly that reason. This loop therefore only REPORTS and ALERTS - it never acks - so
# the two boxes can never invent divergent decisions about the same finding.

param(
    [switch]$Install,
    [switch]$Remove,
    [int]$Hours = 4
)

$ErrorActionPreference = "Stop"
$TaskName = "SmartEntry Medic"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir  = Join-Path $ProjectRoot "tasks\logs"
$LogFile = Join-Path $LogDir "medic.txt"

function Write-MedicLog([string]$Message) {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value ("[$stamp] " + $Message) -Encoding utf8
}

# ---- install / remove --------------------------------------------------------------
if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "removed '$TaskName'"
    } else {
        Write-Output "'$TaskName' was not registered; nothing to remove"
    }
    exit 0
}

if ($Install) {
    if ($Hours -lt 1 -or $Hours -gt 24) { throw "-Hours must be between 1 and 24" }

    $selfPath = Join-Path $ProjectRoot "tasks\medic_loop.ps1"
    if (-not (Test-Path $selfPath)) { throw "cannot find myself at $selfPath" }

    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $selfPath)

    # A REPEATING trigger with an explicit indefinite duration. A one-time trigger with a
    # bounded repetition is how "SmartEntry Spread Probe" ended up with an empty NextRun
    # and never fired again - there it was deliberate, here it would be a silent death.
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(5) `
        -RepetitionInterval (New-TimeSpan -Hours $Hours)

    # Also on unlock and at boot. A logon-only trigger never fires when a laptop lid is
    # opened, which is how coverage gaps of 12h+ happen on this box.
    $atLogon = New-ScheduledTaskTrigger -AtLogOn
    $atStartup = New-ScheduledTaskTrigger -AtStartup

    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)

    # Register-ScheduledTask raises a NON-TERMINATING CimException on "Access is denied"
    # in some hosts, so $ErrorActionPreference alone does not stop the script -- the first
    # version of this block printed the denial and then exited 0, reporting a successful
    # install of a task that does not exist. That is the "green check over a dead
    # component" this project keeps being bitten by, committed by the installer itself.
    # So: force it terminating, catch it, and VERIFY BY READING THE TASK BACK.
    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action `
            -Trigger @($trigger, $atLogon, $atStartup) -Settings $settings -Force `
            -ErrorAction Stop | Out-Null
    } catch {
        Write-Output ("FAILED to register '{0}': {1}" -f $TaskName, $_.Exception.Message)
        if ($_.Exception.Message -match "Access is denied") {
            Write-Output "Registering a scheduled task needs an ADMINISTRATOR shell."
            Write-Output "Re-run this from an elevated PowerShell:"
            Write-Output ('  powershell -ExecutionPolicy Bypass -File "{0}" -Install -Hours {1}' -f $selfPath, $Hours)
        }
        exit 1
    }

    # Registration "succeeding" is not the same as a task that will fire. Read it back.
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Output ("FAILED: '{0}' is not present after registration reported success." -f $TaskName)
        exit 1
    }
    $info = $task | Get-ScheduledTaskInfo
    Write-Output ("registered '{0}' every {1}h (+ logon, + startup). Next run: {2}" -f `
        $TaskName, $Hours, $info.NextRunTime)
    if (-not $info.NextRunTime) {
        Write-Output "WARNING: NextRunTime is EMPTY - nothing will fire this. Investigate before trusting it."
        exit 1
    }
    exit 0
}

# ---- the run ------------------------------------------------------------------------
Set-Location $ProjectRoot

$node = "node"
$medic = Join-Path $ProjectRoot "tasks\medic.cjs"
if (-not (Test-Path $medic)) {
    Write-MedicLog "FAILED - tasks\medic.cjs not found at $medic"
    Write-Output "medic loop: tasks\medic.cjs is missing"
    exit 1
}

# Human-readable pass, straight into the log. This is what a person reads.
$text = & $node $medic 2>&1 | Out-String
$textRc = $LASTEXITCODE

# Machine-readable pass for the counts. Exit 2 from medic means the DOCTOR did not run,
# which is a genuine failure rather than a finding.
$json = & $node $medic "--json" 2>&1 | Out-String
$jsonRc = $LASTEXITCODE

if ($jsonRc -eq 2 -or $textRc -eq 2) {
    Write-MedicLog "FAILED - the medic could not run (doctor unavailable)."
    Write-MedicLog $text.Trim()
    try {
        & python (Join-Path $ProjectRoot "notifications.py") "alert" `
            "MEDIC CANNOT RUN - the doctor did not answer on this box. Fleet health is UNKNOWN, not healthy." `
            --title "JARVIS MEDIC" 2>$null
    } catch { Write-MedicLog ("alert failed: " + $_.Exception.Message) }
    Write-Output $text
    exit 1
}

$counts = $null
try {
    $parsed = $json | ConvertFrom-Json
    $counts = $parsed.counts

    # PERSIST THE CURRENT VIEW, so the dashboard can count LIVE findings instead of
    # ledger history. Measured 2026-09-11: the strip's Medic cell read 7 escalated while
    # the doctor was reporting 3 - the other four were decisions on findings medic.cjs
    # itself lists as CLEARED, meaning the doctor no longer reports them. A cell that
    # counts closed problems is the over-report that makes a light worth ignoring.
    #
    # WRITTEN HERE because `medic.cjs --json` runs the doctor across BOTH boxes; that is
    # far too expensive for a publisher on a page timer, and this job has just paid for
    # it. tasks/coverage_publish.cjs reads this file, falls back to the ledger when it is
    # missing or stale, and states which basis it used either way.
    #
    # [IO.File]::WriteAllText, NOT Set-Content: PowerShell 5.1's Set-Content defaults to
    # the ANSI codepage and this payload is UTF-8 that a browser will JSON.parse. Written
    # to a temp file and moved so a reader can never catch it half-written.
    try {
        $curPath = Join-Path $ProjectRoot 'dashboard\medic-current.json'
        $curTmp = $curPath + '.tmp'
        [IO.File]::WriteAllText($curTmp, $json, (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $curTmp -Destination $curPath -Force
        Write-MedicLog ("published medic-current.json (" + $parsed.totalFindings + " findings)")
    } catch {
        # Reporting only - it must never fail the medic run.
        Write-MedicLog ("WARNING - could not publish medic-current.json: " + $_.Exception.Message)
    }
} catch {
    # Unparseable JSON is REPORTED, never swallowed. The human pass still ran and is logged.
    Write-MedicLog ("WARNING - could not parse medic --json: " + $_.Exception.Message)
}

Write-MedicLog "--- medic run ---"
Write-MedicLog $text.Trim()

if ($counts) {
    $summary = ("new={0} regressed={1} due={2} handled={3} unreadable={4} corrupt={5} cleared={6}" -f `
        $counts.new, $counts.regressed, $counts.due, $counts.handled, `
        $counts.unreadable, $counts.corruptLedgerLines, $counts.cleared)
    Write-MedicLog $summary
    Write-Output $summary

    # REGRESSED first and always: a repair that did not hold is the single most important
    # thing this system can say. Everything unhandled is worth a nudge, but that one is
    # worth interrupting someone for.
    $needsAlert = ($counts.regressed -gt 0) -or ($counts.new -gt 0) -or `
                  ($counts.unreadable -gt 0) -or ($counts.corruptLedgerLines -gt 0)

    if ($needsAlert) {
        $lead = if ($counts.regressed -gt 0) {
            "{0} REGRESSED (a fix did not hold)" -f $counts.regressed
        } elseif ($counts.unreadable -gt 0 -or $counts.corruptLedgerLines -gt 0) {
            "unreadable finding(s) or corrupt ledger line(s)"
        } else {
            "{0} NEW finding(s) nobody has decided" -f $counts.new
        }
        $msg = ("MEDIC: {0}. {1}. Run: node tasks/medic.cjs" -f $lead, $summary)
        try {
            & python (Join-Path $ProjectRoot "notifications.py") "alert" $msg --title "JARVIS MEDIC" 2>$null
            Write-MedicLog "alert sent"
        } catch {
            Write-MedicLog ("alert failed: " + $_.Exception.Message)
        }
    }
}

Write-Output $text

# ── Publish the ledger so the dashboard can show what is waiting on the user ─────
# The SAME publisher the coverage audit calls, for the same reason: it runs when the
# data it reports changes, so nothing new has to be registered with the scheduler.
# It writes BOTH artefacts on every run, so calling it from each producer keeps each
# cell as fresh as its own source and no fresher - publishing unchanged data more
# often would only make a stale figure look current.
#
# WHY THE STRIP READS THIS FILE AND NOT /api/medic: that route re-runs the doctor
# across BOTH boxes on a cache miss (server/index.js:14634) and offers no cache-only
# read, so a strip on a refresh timer would fire 20-second fleet doctor runs on a page
# reload. The ledger is already on disk and costs a file read.
#
# WRAPPED AND SILENCED. `exit 0` below is deliberate and documented at the top of this
# file - findings are not a job failure - and a reporting artefact must not be able to
# change that.
try {
    $publisher = Join-Path $ProjectRoot 'tasks\coverage_publish.cjs'
    if (Test-Path $publisher) {
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
        if (Test-Path $nodeExe) { & $nodeExe $publisher *> $null }
    }
} catch { }

# The medic RAN. Findings are not a job failure - see the exit-code note at the top.
exit 0
