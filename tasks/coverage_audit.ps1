# Prove nothing in the SmartEntry stack is running blind.
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File tasks\coverage_audit.ps1
#
# WHY
# Every outage this project has had looked identical to health while it was
# happening. The VPS placed no orders for eleven days with every check green. Both
# daily agents answered "I don't have the data" for weeks. The trailing stop had
# never fired once. SmartEntryAutoStart has never run at all and still reports
# "Ready". A component that is ABSENT reads the same as one that is fine, and that
# is the failure shape here -- not crashes, silence.
#
# This asks one question of every moving part: when did it last actually do its job,
# and does anything notice if it stops? A check that cannot be answered is reported
# UNKNOWN, never assumed healthy.
#
# Portable: paths come from $PSScriptRoot, so it runs unchanged on the laptop
# (C:\Users\User\ai-trading-dashboard) and the VPS (C:\ai-trading-dashboard).
#
# Exit 0 = all green or amber. Exit 1 = at least one RED. Designed to be run daily
# and to be worth reading when it is quiet.

$ErrorActionPreference = 'Continue'

$Proj    = Split-Path -Parent $PSScriptRoot
$LogDir  = Join-Path $Proj 'tasks\logs'
$SERVER  = 'http://localhost:3001'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

$results = @()
function Add-Check([string]$area, [string]$name, [string]$state, [string]$detail) {
    $script:results += [pscustomobject]@{ Area = $area; Name = $name; State = $state; Detail = $detail }
}

function Get-Json([string]$path, [int]$timeout = 6) {
    try { return Invoke-RestMethod -Uri "$SERVER$path" -TimeoutSec $timeout } catch { return $null }
}

# ── 1. Scheduled tasks: the supervisors themselves ────────────────────────────
# 267009 is "currently running" and 267011 is "has not run yet" -- the second is the
# one that matters. A task registered years ago that has never fired is the purest
# form of blind: it exists, it reports Ready, and it has never done anything.
$now = Get-Date

# Probed BEFORE the task loop because the loop needs it. Section 2 below already states
# the principle -- "by HTTP, never by process name" -- and then section 1 judged the
# server by its scheduler exit code anyway, so the same report could say RED on
# SmartEntryServer and GREEN on the server in the same breath. Measured on the VPS
# 2026-08-23: task State=Ready, LastTaskResult=4294967295, and the server answering
# every request with a bridge heartbeat 25s old. The task is Ready because
# EnsureRunning started the process, not this task; a scheduler's opinion of a task
# says nothing about whether the service is up.
$serverAnswering = $null -ne (Get-Json '/api/status')

$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'SmartEntry' })
if ($tasks.Count -eq 0) {
    Add-Check 'tasks' 'scheduled tasks' 'RED' 'no SmartEntry tasks registered on this box at all'
} else {
    foreach ($t in $tasks) {
        $i = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
        if ($null -eq $i) { Add-Check 'tasks' $t.TaskName 'UNKNOWN' 'task info unreadable'; continue }

        if ($t.State -eq 'Disabled') { Add-Check 'tasks' $t.TaskName 'INFO' 'disabled deliberately'; continue }

        $ranEver = $i.LastRunTime -and $i.LastRunTime.Year -gt 1999
        $ageH    = if ($ranEver) { [math]::Round(($now - $i.LastRunTime).TotalHours, 1) } else { $null }

        # "Never run" only means something once you know what would have run it.
        # A Boot-triggered task that has never fired just means the box has not
        # rebooted, which is not a fault -- calling it RED trains the reader to
        # ignore the summary, and then the real ones go unread too. A LOGON-
        # triggered task on a box nobody logs into is the opposite: it will never
        # fire, and that is exactly how the VPS ended up with its whole stack
        # waiting on a human who never arrives.
        $trigKinds = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName })
        $hasBoot   = @($trigKinds | Where-Object { $_ -match 'Boot' }).Count -gt 0
        $logonOnly = ($trigKinds.Count -gt 0) -and -not (@($trigKinds | Where-Object { $_ -notmatch 'Logon' }).Count)
        # An UNLOCK trigger (MSFT_TaskSessionStateChangeTrigger) has no NextRunTime
        # either, and it is STRONGER coverage than logon-only on a laptop -- it is the
        # trigger that actually fires when the lid opens. It does not match 'Logon', so
        # 'Morning Ready' (logon + unlock) fell past $logonOnly and reported AMBER
        # 'nothing will fire it again' every day while firing every day. A false AMBER
        # on a status surface is the same failure as a false RED.
        $eventOnly = ($trigKinds.Count -gt 0) -and -not (@($trigKinds | Where-Object { $_ -notmatch 'Logon|SessionStateChange' }).Count)

        if (-not $ranEver -or $i.LastTaskResult -eq 267011) {
            # The question is not "has it run" but "will it". A scheduled next run
            # answers that outright, and a boot trigger answers it for the next
            # reboot. Only a task with neither is genuinely stranded.
            if ($null -ne $i.NextRunTime) {
                Add-Check 'tasks' $t.TaskName 'INFO' "not run yet, first run $($i.NextRunTime.ToString('MM-dd HH:mm'))"
            } elseif ($hasBoot) {
                Add-Check 'tasks' $t.TaskName 'INFO' 'boot-triggered, will fire on the next reboot'
            } elseif ($logonOnly -and -not [Environment]::UserInteractive) {
                Add-Check 'tasks' $t.TaskName 'RED' 'LOGON-triggered on a headless box - it will never fire'
            } else {
                Add-Check 'tasks' $t.TaskName 'RED' 'registered, never run, and nothing scheduled to run it'
            }
        } elseif ($t.State -eq 'Running') {
            # Checked BEFORE LastTaskResult on purpose. For the long-running services
            # -- server, bridge, watchdog -- LastTaskResult describes the PREVIOUS
            # instance, so a task that is serving traffic right now was being reported
            # RED because the instance before it had been force-stopped. Measured on
            # the VPS: SmartEntryServer showed "last exit 2147946720" while answering
            # every request and passing every other check. Running now is healthy now;
            # the old exit is history, and is carried in the detail rather than lost.
            $prior = if ($i.LastTaskResult -ne 0 -and $i.LastTaskResult -ne 267009) {
                " (previous instance exited $($i.LastTaskResult))"
            } else { '' }
            Add-Check 'tasks' $t.TaskName 'GREEN' "running (started ${ageH}h ago)$prior"
        } elseif ($t.TaskName -match 'CoverageAudit' -and $i.LastTaskResult -eq 1) {
            # THIS AUDIT, JUDGING ITSELF. Exit 1 is how this script SAYS SOMETHING IS
            # RED -- server/ai_work_ledger.js already encodes that as exitOneIsFinding.
            # The task loop did not, so the first RED it ever reported set its own
            # LastTaskResult to 1, which it then read back as a crash and reported as a
            # RED, which made it exit 1 again. A permanent alarm that could never clear,
            # and the report's one RED line became the audit's own name rather than the
            # thing actually broken -- burying the finding this audit exists to surface.
            #
            # Only rc=1 is exempted, and only for this task. A real crash here (2, or a
            # PowerShell fault code) still reads RED.
            Add-Check 'tasks' $t.TaskName 'GREEN' "ok ${ageH}h ago (exit 1 = a RED finding in its own last report, not a crash)"
        } elseif ($t.TaskName -match 'Refresh\s*Bars' -and $i.LastTaskResult -eq 3) {
            # Exit 3 is refresh_bars.cjs REFUSING because a position is open, which its
            # own header calls "the EXPECTED result most days - it is not a failure and
            # must not be alerted on as one". The task loop did not know that and read it
            # as a crash, so a correct guard doing its job was the audit's headline RED.
            #
            # This got worse on 2026-08-23, when the task went from firing once a day to
            # hourly so it could catch the first flat book instead of sampling for one.
            # That is 24 refusals a day, and 24 false REDs a day, which is exactly how a
            # report stops being read.
            #
            # THE TASK IS NAMED DIFFERENTLY ON THE TWO BOXES: 'SmartEntryRefreshBars' on
            # the VPS and 'SmartEntry Refresh Bars' on the laptop. The first version of
            # this branch matched 'RefreshBars' and silently did nothing on the laptop,
            # which still reported RED while the VPS went quiet. \s* covers both.
            #
            # Only rc=3 on this one task is exempted; any other non-zero still reads RED.
            # The thing actually worth alarming on is not the exit code but whether the
            # BARS have gone stale, and that is a separate check below -- an exit code
            # says whether the tool ran, never whether the data moved.
            Add-Check 'tasks' $t.TaskName 'INFO' "refused ${ageH}h ago (exit 3 = a position was open, the expected result)"
        } elseif ($t.TaskName -match 'Server' -and $serverAnswering) {
            # Third instance of one root cause, all found in a single session: judging a
            # service by its supervisor's exit code instead of by whether the service
            # answers. The other two were CoverageAudit's own rc=1 and RefreshBars' rc=3.
            #
            # The guard here is not the name match, it is $serverAnswering: if the server
            # is NOT answering, this branch does not apply and the exit code reads RED as
            # before. A wrong name simply misses the exemption, which fails toward the
            # alarm rather than away from it.
            Add-Check 'tasks' $t.TaskName 'INFO' "task is $($t.State) with exit $($i.LastTaskResult), but the server IS answering on 3001 - the process was started by EnsureRunning, not by this task"
        } elseif ($i.LastTaskResult -ne 0 -and $i.LastTaskResult -ne 267009) {
            Add-Check 'tasks' $t.TaskName 'RED' "last exit $($i.LastTaskResult), ${ageH}h ago"
        } elseif ($null -eq $i.NextRunTime) {
            # No next run, and it is not running. The same reasoning the never-run branch
            # above already applies was missing here, so every boot- and logon-triggered
            # task that had ever run reported AMBER forever: those triggers have no
            # scheduled next time by definition, not because they are broken.
            #
            # THE FACT THAT IT HAS RUN IS THE EVIDENCE. A logon-triggered task that has
            # actually fired proves logons happen on this box, which is stronger than
            # inferring it from [Environment]::UserInteractive -- that reads the session
            # the AUDIT runs in, not the one the other task runs in.
            if ($hasBoot) {
                Add-Check 'tasks' $t.TaskName 'INFO' "ok ${ageH}h ago, boot-triggered - fires again on the next reboot"
            } elseif ($logonOnly) {
                # Not silent: logon-only is thin coverage even where it works. It is the
                # exact shape that left the VPS dead after a reboot, and on a laptop it
                # never fires on a lid-open. Named as a limitation, not a fault.
                Add-Check 'tasks' $t.TaskName 'INFO' "ok ${ageH}h ago, LOGON-only - fires again at next logon, and never on lid-open or unlock"
            } elseif ($eventOnly) {
                Add-Check 'tasks' $t.TaskName 'INFO' "ok ${ageH}h ago, event-triggered (logon + unlock) - fires again at the next logon or lid-open, which is why it has no next run time"
            } else {
                Add-Check 'tasks' $t.TaskName 'AMBER' "ok ${ageH}h ago but NO next run scheduled and no boot/logon trigger - nothing will fire it again"
            }
        } else {
            Add-Check 'tasks' $t.TaskName 'GREEN' "ok ${ageH}h ago, next $($i.NextRunTime.ToString('MM-dd HH:mm'))"
        }
    }
}

# ── 2. Server ─────────────────────────────────────────────────────────────────
# By HTTP, never by process name: a node process that is alive but wedged is not a
# running server.
$settings = Get-Json '/api/strategy-settings'
if ($null -eq $settings) {
    Add-Check 'server' 'http' 'RED' 'not answering on 3001'
} else {
    Add-Check 'server' 'http' 'GREEN' "gate $($settings.confidenceThreshold), fixedLot $($settings.fixedLotSize)"
    if ($settings.settingsError) {
        # Defaults are NOT the operator's settings: fixedLotSize defaults to 0, which
        # means size from risk on a box configured for micro lots.
        Add-Check 'server' 'strategy settings' 'RED' "UNREADABLE ($($settings.settingsError)) - running on DEFAULTS, not the saved config"
    } else {
        Add-Check 'server' 'strategy settings' 'GREEN' 'loaded from disk'
    }
}

# How long the server has been up. Bridge and peer liveness both live in the
# server's MEMORY, so a restart empties them and everything looks dead for about a
# minute. Auditing inside that window reports RED for things that are fine and fires
# a Telegram alert for nothing -- and a false alarm is the one thing that makes the
# real ones get ignored. Measured on the VPS at 16:02: immediately after a restart
# the audit called bridge A "not connected"; 75s later it was connected with a 19s
# heartbeat, having never actually stopped.
$serverAgeS = [int]::MaxValue
$status = Get-Json '/api/status'
if ($status -and $status.startedAt) {
    try { $serverAgeS = [int]((Get-Date).ToUniversalTime() - ([datetime]$status.startedAt).ToUniversalTime()).TotalSeconds } catch { }
}
$SERVER_WARMUP_S = 120
$inWarmup = $serverAgeS -lt $SERVER_WARMUP_S
if ($inWarmup) {
    Add-Check 'server' 'warmup' 'INFO' "server started ${serverAgeS}s ago - in-memory liveness not yet repopulated, holding fire on bridge/peer"
}

$healer = Get-Json '/api/healer'
if ($null -eq $healer) { Add-Check 'server' 'healer' 'UNKNOWN' 'endpoint unreachable' }
elseif ($healer.healthy) { Add-Check 'server' 'healer' 'GREEN' "healthy, $($healer.healCount) heals" }
else { Add-Check 'server' 'healer' 'RED' 'reporting unhealthy' }

# ── 3. Bridges — per expected tag, by heartbeat ───────────────────────────────
# Liveness is the heartbeat, not a process: Windows reports an EMPTY command line for
# the bridge pythons, so they look absent while trading normally.
$tags = @('A')
$envFile = Join-Path $Proj 'keys.env'
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*MT5_EXPECTED_ACCOUNTS\s*=' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($line) {
        $val = ($line.Line -split '=', 2)[1]
        if ($val) { $parsed = @($val.Trim() -split '\s*,\s*' | Where-Object { $_ }); if ($parsed.Count) { $tags = $parsed } }
    }
}
foreach ($tag in $tags) {
    $h = Get-Json "/api/mt5/health?account=$tag"
    if ($null -eq $h) { Add-Check 'bridge' "tag $tag" 'UNKNOWN' 'server not answering' ; continue }
    if (-not $h.connected) {
        if ($inWarmup) { Add-Check 'bridge' "tag $tag" 'INFO' 'not connected yet - server restarted moments ago' }
        else           { Add-Check 'bridge' "tag $tag" 'RED'  'not connected' }
        continue
    }
    $ageS = [math]::Round($h.ageMs / 1000, 0)
    if ($ageS -gt 180) { Add-Check 'bridge' "tag $tag" 'RED' "last heartbeat ${ageS}s ago (3 missed reports)" }
    elseif ($ageS -gt 90) { Add-Check 'bridge' "tag $tag" 'AMBER' "last heartbeat ${ageS}s ago" }
    else { Add-Check 'bridge' "tag $tag" 'GREEN' "heartbeat ${ageS}s ago" }
}

# ── 4. The AI Employee: is any brief stranded? ────────────────────────────────
$queue = Join-Path $Proj 'tasks\agent_queue.jsonl'
if (-not (Test-Path $queue)) {
    Add-Check 'agents' 'parked briefs' 'GREEN' 'queue empty (no file)'
} else {
    $lines = @(Get-Content $queue -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
    if ($lines.Count -eq 0) { Add-Check 'agents' 'parked briefs' 'GREEN' 'queue empty' }
    else {
        $oldest = $null
        $authParked = 0
        foreach ($l in $lines) {
            try { $j = $l | ConvertFrom-Json } catch { continue }
            if ($j.queuedAt) {
                $qd = [datetime]$j.queuedAt
                if ($null -eq $oldest -or $qd -lt $oldest) { $oldest = $qd }
            }
            # Written by claude_agent.py's queue_job. Absent on rows parked before that
            # field existed, which read as a limit - the old assumption, and harmless.
            if ($j.parkedBecause -eq 'auth') { $authParked++ }
        }
        $ageH = if ($oldest) { [math]::Round(($now - $oldest).TotalHours, 1) } else { -1 }
        # A LIMIT CLEARS ITSELF. AN EXPIRED LOGIN DOES NOT. Saying "waiting on the limit
        # window" for an auth-parked brief tells the reader to wait for something that is
        # never coming, and the drain will keep skipping it until a person signs in.
        $waitingOn = if ($authParked -gt 0) {
            "$authParked of them waiting on a SIGN-IN, which will not clear on its own - run ``claude`` on this box"
        } else {
            'waiting on the limit window'
        }
        if ($ageH -gt 48) { Add-Check 'agents' 'parked briefs' 'RED' "$($lines.Count) parked, oldest ${ageH}h - past the staleness drop, drain is not running" }
        elseif ($authParked -gt 0) { Add-Check 'agents' 'parked briefs' 'RED' "$($lines.Count) parked, oldest ${ageH}h - $waitingOn" }
        elseif ($lines.Count -gt 0) { Add-Check 'agents' 'parked briefs' 'AMBER' "$($lines.Count) parked, oldest ${ageH}h - $waitingOn" }
    }
}

# ── 5. Self-learning: is evidence still accumulating? ─────────────────────────
foreach ($f in @(
    @{ Name = 'rejection ledger'; Path = 'tasks\rejections.jsonl';        MaxAgeH = 48 },
    @{ Name = 'scored ledger';    Path = 'tasks\rejections_scored.jsonl'; MaxAgeH = 48 },
    @{ Name = 'shadow learning';  Path = 'server\learning_shadow.json';   MaxAgeH = 48 }
)) {
    $p = Join-Path $Proj $f.Path
    if (-not (Test-Path $p)) {
        Add-Check 'learning' $f.Name 'AMBER' "$($f.Path) does not exist yet"
    } else {
        $ageH = [math]::Round(($now - (Get-Item $p).LastWriteTime).TotalHours, 1)
        if ($ageH -gt $f.MaxAgeH) { Add-Check 'learning' $f.Name 'RED' "not updated for ${ageH}h - the daily pipeline is not running" }
        else { Add-Check 'learning' $f.Name 'GREEN' "updated ${ageH}h ago" }
    }
}

# ── 5b. The research bars: is the searcher looking at anything new? ──────────
#
# ADDED 2026-08-23, replacing an alarm that was firing on the wrong thing. The audit
# reported SmartEntryRefreshBars RED for exiting 3 -- its documented refusal -- while
# saying NOTHING about the fact that the cached D1 bars had not moved since 2026-07-26.
# Twenty-eight days of the daily strategy search re-testing identical data, and the one
# check that mentioned bars at all was complaining about a guard working correctly.
#
# An exit code says whether the tool RAN. It never says whether the data MOVED. Those
# are different questions and only the second one matters here.
#
# Thresholds: a refresh needs a flat book, and this system holds trades for days, so a
# few stale days is normal and is not an alarm. Past a week the searcher is re-asking
# settled questions; past a fortnight its candidate count is growing while its evidence
# is not, which is the failure mode the searcher's own multiplicity warning exists for.
$barFile = Join-Path $Proj 'tasks\history\BTCUSD_D1.csv'
if (-not (Test-Path $barFile)) {
    Add-Check 'learning' 'research bars' 'RED' 'tasks\history\BTCUSD_D1.csv is missing - every replay reads it'
} else {
    $barAgeD = [math]::Round(($now - (Get-Item $barFile).LastWriteTime).TotalDays, 1)
    if ($barAgeD -gt 14) {
        Add-Check 'learning' 'research bars' 'RED' "cached ${barAgeD}d ago - the strategy search is re-testing identical data"
    } elseif ($barAgeD -gt 7) {
        Add-Check 'learning' 'research bars' 'AMBER' "cached ${barAgeD}d ago - no flat book has come up in a week"
    } else {
        Add-Check 'learning' 'research bars' 'GREEN' "cached ${barAgeD}d ago"
    }
}

# ── 5c. The PLAN ARTIFACTS, not the runner that makes them ───────────────────
#
# ADDED 2026-08-29. Section 1 above reads `SmartEntry TV Daily Plan`'s last exit code
# and reported it GREEN while SIX of the previous fourteen days had no daily plan at
# all (2026-08-16, -17, -20, -21, -23, -27 -- a 43% miss rate). That is not a bug in
# section 1; it is what an exit code IS. It describes the most recent run that
# HAPPENED and is structurally incapable of saying anything about a day on which
# nothing ran, which is exactly what a sleeping laptop produces.
#
# So this checks the ARTIFACT. Same reason the bridge is checked by its heartbeat and
# not by a process listing.
#
# TODAY absent is the only RED, and it is one a reader can actually clear: the server
# regenerates a missing plan on boot and on every 30-minute tick, so if it is still
# absent the generator itself is failing. The historical gaps are INFO forever -- a
# plan cannot be generated for a day whose market has moved on, and an alarm that can
# never clear teaches the reader to skim past the one that matters.
$planCoverage = $null
try {
    $planJson = & node (Join-Path $Proj 'tasks\plan_coverage.cjs') --json 2>$null
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 1) { $planCoverage = $planJson | ConvertFrom-Json }
} catch { $planCoverage = $null }

if ($null -eq $planCoverage) {
    Add-Check 'learning' 'plan coverage' 'UNKNOWN' 'tasks\plan_coverage.cjs did not return usable JSON'
} else {
    if ($planCoverage.todayPresent) {
        Add-Check 'learning' 'daily plan today' 'GREEN' "$($planCoverage.todayDate) is on disk"
    } else {
        Add-Check 'learning' 'daily plan today' 'RED' "no plan for $($planCoverage.todayDate) - the server catch-up is not producing one"
    }

    $missCount = @($planCoverage.missing).Count
    if ($missCount -eq 0) {
        Add-Check 'learning' 'daily plan history' 'GREEN' "$($planCoverage.coveragePct)% over the last $($planCoverage.windowDays) days - no gaps"
    } else {
        Add-Check 'learning' 'daily plan history' 'INFO' "$($planCoverage.coveragePct)% over $($planCoverage.windowDays) days - $missCount missing (history, not recoverable): $(@($planCoverage.missing) -join ', ')"
    }

    if ($null -eq $planCoverage.weekly.newest) {
        Add-Check 'learning' 'weekly review' 'AMBER' 'no tasks\logs\weekly_YYYYMMDD.txt has ever been written on this box'
    } elseif ($planCoverage.weekly.overdue) {
        Add-Check 'learning' 'weekly review' 'RED' "newest is $($planCoverage.weekly.newest), $($planCoverage.weekly.ageDays)d ago - a full cycle has been skipped"
    } else {
        Add-Check 'learning' 'weekly review' 'GREEN' "$($planCoverage.weekly.newest), $($planCoverage.weekly.ageDays)d ago - on cadence"
    }
}

# ── 5d. Two things that were happening with nobody watching ──────────────────
#
# ADDED 2026-08-29, both for the same reason: something was going on and no surface
# could say so.
#
# SERVER RESTARTS. On 2026-08-29 this server restarted at 09:45 local and nothing on
# the box could say when or why. /api/status carries only the CURRENT startedAt, which
# the next restart overwrites, and the boot banner in server_log.txt has no timestamp.
# The count is now recorded per boot. It is INFO at normal rates -- a restart is not a
# fault, and alarming on one would be an item that fires on every ordinary deploy --
# and RED only at a rate that means thrashing.
#
# STOP-VARIANT LEDGER. It had a writer and no reader for two days. A file that only
# grows is indistinguishable from a file nothing is doing, which is why it needs a row
# of its own rather than being assumed healthy because its writer is running.
$startsFile = Join-Path $Proj 'tasks\logs\server_starts.txt'
if (-not (Test-Path $startsFile)) {
    Add-Check 'server' 'restarts' 'INFO' 'no starts recorded yet - this server has not rebooted since the recorder shipped'
} else {
    $cutoff = $now.AddHours(-24)
    $recent = @(Get-Content $startsFile | ForEach-Object {
        if ($_ -match '^\[(?<ts>[^\]]+)\]') {
            try { [datetime]::Parse($Matches['ts']).ToLocalTime() } catch { $null }
        }
    } | Where-Object { $_ -and $_ -gt $cutoff })
    $lastStart = if ($recent.Count) { ($recent | Sort-Object)[-1].ToString('HH:mm') } else { 'none in 24h' }
    if ($recent.Count -gt 6) {
        Add-Check 'server' 'restarts' 'RED' "$($recent.Count) starts in 24h (last $lastStart) - that is thrashing, not deploys"
    } elseif ($recent.Count -gt 0) {
        Add-Check 'server' 'restarts' 'INFO' "$($recent.Count) start(s) in the last 24h, last at $lastStart"
    } else {
        Add-Check 'server' 'restarts' 'GREEN' 'no restarts in the last 24h'
    }
}

# The scorer is tasks\score_stop_variants.cjs, which auto_daily.bat already runs
# nightly with --emit, and its artifact is the report it appends. Checking for the
# REPORT rather than for the ledger is the point: the ledger growing proves only that
# the writer runs, and it was the READER that was missing.
$variantLedger = Join-Path $Proj 'tasks\stop_variants.jsonl'
$variantReport = Join-Path $Proj 'tasks\logs\stop_variant_scores.txt'
if (-not (Test-Path $variantLedger)) {
    Add-Check 'learning' 'stop-variant ledger' 'INFO' 'nothing recorded yet - the writer only fires when a setup forms'
} else {
    $variantRows = @(Get-Content $variantLedger | Where-Object { $_.Trim() }).Count
    if (-not (Test-Path $variantReport)) {
        Add-Check 'learning' 'stop-variant ledger' 'AMBER' "$variantRows row(s) accumulating, never scored - run node tasks\score_stop_variants.cjs --emit"
    } else {
        $scoredAgeH = [math]::Round(($now - (Get-Item $variantReport).LastWriteTime).TotalHours, 1)
        if ($scoredAgeH -gt 48) {
            Add-Check 'learning' 'stop-variant ledger' 'AMBER' "$variantRows row(s), last scored ${scoredAgeH}h ago - the nightly scorer has not run"
        } else {
            Add-Check 'learning' 'stop-variant ledger' 'GREEN' "$variantRows row(s), scored ${scoredAgeH}h ago"
        }
    }
}

# ── 6. The OTHER box ──────────────────────────────────────────────────────────
#
# Only meaningful on the box that RECEIVES heartbeats. The laptop pushes one every 5
# minutes from vps_monitor.ps1; the VPS is always on and always reachable, so it is
# the one that can notice the laptop going quiet. A box that has never reported is
# not an alarm -- it may simply not be configured to -- but one that reported and
# then stopped is exactly the failure nothing used to catch.
$peers = Get-Json '/api/peer-heartbeat'
if ($null -eq $peers) {
    Add-Check 'peers' 'peer heartbeat' 'UNKNOWN' 'endpoint unreachable'
} elseif (-not $peers.peers -or @($peers.peers).Count -eq 0) {
    $why = if ($inWarmup) { 'server restarted moments ago - peers report every 5 min' }
           else { 'no peer has reported to this box yet' }
    Add-Check 'peers' 'peer heartbeat' 'INFO' $why
} else {
    foreach ($p in @($peers.peers)) {
        if ($p.box -eq $env:COMPUTERNAME) { continue }   # our own reflection is not evidence
        $mins = [math]::Round($p.ageSeconds / 60, 1)
        if ($p.ageSeconds -gt 1800) {
            Add-Check 'peers' "peer $($p.box)" 'RED' "silent for ${mins} min - that box has stopped reporting"
        } elseif ($p.status -ne 'ok') {
            Add-Check 'peers' "peer $($p.box)" 'AMBER' "reporting '$($p.status)': $($p.detail)"
        } else {
            Add-Check 'peers' "peer $($p.box)" 'GREEN' "reported ${mins} min ago"
        }
    }
}

# ── 7. Can this box raise an alarm at all? ────────────────────────────────────
#
# Checked LAST and treated as the most serious kind of failure, because every green
# above is worth very little if the answer is no. tasks/vps_monitor.ps1 is the
# external dead-man's switch -- it runs on the laptop precisely so a powered-off VPS
# still produces an alert -- and on 2026-08-07 it was found to have never sent one
# and to be incapable of it: the laptop's keys.env has no TELEGRAM_TOKEN. Armed and
# mute, with nothing reporting that, because "no alert arrived" is indistinguishable
# from "nothing went wrong".
. (Join-Path $PSScriptRoot 'notify.ps1')
$notifierOk = Test-NotifierConfigured
if ($notifierOk) {
    Add-Check 'alerting' 'notifier' 'GREEN' (Get-NotifierStatus)
} else {
    Add-Check 'alerting' 'notifier' 'RED' (Get-NotifierStatus)
}

# ── report ────────────────────────────────────────────────────────────────────
$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$out = @()
$out += "=========================================================================="
$out += " SmartEntry COVERAGE AUDIT - $stamp"
$out += " box: $env:COMPUTERNAME   project: $Proj"
$out += "=========================================================================="
foreach ($area in @('tasks','server','bridge','agents','learning','peers','alerting')) {
    $rows = @($results | Where-Object { $_.Area -eq $area })
    if ($rows.Count -eq 0) { continue }
    $out += ''
    $out += "  [$($area.ToUpper())]"
    foreach ($r in $rows) { $out += ("    {0,-7} {1,-32} {2}" -f $r.State, $r.Name, $r.Detail) }
}
$red     = @($results | Where-Object { $_.State -eq 'RED' })
$amber   = @($results | Where-Object { $_.State -eq 'AMBER' })
$unknown = @($results | Where-Object { $_.State -eq 'UNKNOWN' })
$out += ''
$out += "--------------------------------------------------------------------------"
$out += (" {0} checks: {1} RED, {2} AMBER, {3} UNKNOWN, {4} GREEN/INFO" -f `
    $results.Count, $red.Count, $amber.Count, $unknown.Count,
    (@($results | Where-Object { $_.State -eq 'GREEN' -or $_.State -eq 'INFO' })).Count)
if ($red.Count)     { $out += ' RED   : ' + (($red     | ForEach-Object { $_.Name }) -join ', ') }
if ($unknown.Count) { $out += ' UNKNOWN (could not be answered - NOT the same as healthy): ' + (($unknown | ForEach-Object { $_.Name }) -join ', ') }
$out += "=========================================================================="

$out | ForEach-Object { Write-Output $_ }
$logPath = Join-Path $LogDir 'coverage_audit.txt'
try { $out | Out-File -FilePath $logPath -Encoding utf8 -Append } catch { }

# ── tell someone, but only on a CHANGE ────────────────────────────────────────
#
# On transition into RED and again on recovery, never every run. A 12-hourly job
# that re-sends the same alarm becomes noise you learn to ignore, which is the same
# as having no alarm -- the lesson tasks/vps_monitor.ps1 already encodes.
$statePath = Join-Path $LogDir 'coverage_audit_state.json'
$wasRed = $false
if (Test-Path $statePath) {
    try { $wasRed = [bool](Get-Content $statePath -Raw | ConvertFrom-Json).red } catch { $wasRed = $false }
}
$isRed = $red.Count -gt 0

if ($isRed -ne $wasRed) {
    $names = ($red | ForEach-Object { "$($_.Name) - $($_.Detail)" }) -join "`n  "
    $msg = if ($isRed) {
        "SmartEntry COVERAGE RED on $env:COMPUTERNAME`n  $names"
    } else {
        "SmartEntry coverage RECOVERED on $env:COMPUTERNAME - all checks green again"
    }
    # Write-Output alone goes to a stream Task Scheduler discards, so whether the
    # alarm was DELIVERED left no trace: 2,164 lines of this log and not one record
    # either way. A send that silently failed looked identical to one that worked.
    $outcome = if (-not $notifierOk)           { ' (NO ALERT SENT - this box has no notifier configured)' }
               elseif (Send-Notification $msg) { ' (alert sent)' }
               else                            { ' (ALERT SEND FAILED - the transition was not delivered)' }
    Write-Output $outcome
    try { "$stamp$outcome" | Out-File -FilePath $logPath -Encoding utf8 -Append } catch { }
}
try { @{ red = $isRed; at = $stamp } | ConvertTo-Json | Out-File -FilePath $statePath -Encoding utf8 } catch { }

# Completion marker, so the AI-employee ledger can tell a finished audit from one
# that was killed mid-run. Without it this job reads NO COMPLETION MARKER forever,
# whatever the scheduler recorded. Note 1 here means A RED FINDING, not a crash —
# the ledger knows that and reports REPORTS RED rather than FAILING.
$exitCode = if ($isRed) { 1 } else { 0 }
$marker = "[exit $exitCode]"

# The marker has to land IN THE LOG FILE, not merely on stdout. Until 2026-08-16 this
# only ever wrote to stdout, and the log was already closed by then because $out is
# piped to $logPath further up. Nothing captures this script's stdout, so the marker
# went nowhere: coverage_audit.txt held ZERO of them across every run it had ever made.
# exitCodeFrom() in server/ai_work_ledger.js reads the FILE, so the ledger reported
# NO COMPLETION MARKER forever while the scheduler recorded rc=0 throughout - a
# permanent false amber on a job that was in fact healthy every single time.
# Appended, never rewritten: this log is append-only by design.
try { $marker | Out-File -FilePath $logPath -Encoding utf8 -Append } catch { }

Write-Output $marker
exit $exitCode
