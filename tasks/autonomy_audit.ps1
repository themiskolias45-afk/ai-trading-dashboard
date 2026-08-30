# Every scheduled job on this box, and whether it can actually do its job.
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File tasks\autonomy_audit.ps1
#
# ASCII ONLY. PowerShell 5.1 reads a .ps1 as ANSI without a BOM, so one em-dash
# arrives carrying a quote character and the file stops parsing.
#
# WHAT THIS ADDS OVER tasks\coverage_audit.ps1, which is the other half of the
# picture and should still be run.
#
#   coverage_audit answers "did each moving part do its job recently". It reads
#   last-run times and artifact ages. It does NOT open the task's ACTION and ask
#   whether the file that action points at is on disk.
#
#   That gap is not theoretical. tasks\install_schedule.bat hardcoded
#   C:\Users\User\ai-trading-dashboard in five places; run on the VPS, whose project
#   is C:\ai-trading-dashboard, it would have registered four tasks pointing at a
#   directory that does not exist. Each would fail on every trigger, report
#   LastTaskResult non-zero, and be invisible to anything reading artifact ages -
#   because a job that never ran writes no artifact and simply looks quiet.
#
#   It also asks whether each task's TRIGGERS can fire at all on this box. A
#   logon-triggered task on a headless server cannot start: that is
#   0x800710E0 / ERROR_NO_INTERACTIVE_SESSION, and it is why SmartEntryServer could
#   not be restarted on demand and why a whole sweep of VPS jobs was once silently
#   dead while every one of them reported "Ready".
#
# READ-ONLY. It registers nothing, changes nothing, deletes nothing, and starts no
# task. Exit 0 always: this is a report, and a report that fails a daily run teaches
# people to stop running it.

$ErrorActionPreference = 'Continue'

$Proj = Split-Path -Parent $PSScriptRoot
$IsHeadless = ($env:COMPUTERNAME -like 'VMI*')

Write-Host ''
Write-Host '=========================================================================='
Write-Host (" AUTONOMY AUDIT - " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Host (" box: " + $env:COMPUTERNAME + "   project: " + $Proj)
Write-Host (" headless: " + $IsHeadless + "   (logon-only triggers cannot fire when true)")
Write-Host '=========================================================================='
Write-Host ''

# Task result codes worth naming. An undecoded number sends the reader to a search
# engine; the name tells them whether to act.
# [long], not [int]. 2147946720 (0x800710E0, NO INTERACTIVE SESSION) overflows
# Int32 and throws - and that is precisely the code this audit exists to surface,
# so the cast that breaks is the one guarding the finding that matters most.
function Decode-Result([long]$code) {
    switch ($code) {
        0          { return 'ok' }
        1          { return 'exit 1 - the script itself reported a failure' }
        3          { return 'exit 3 - refresh_bars refusal (a position is open): EXPECTED' }
        5          { return 'exit 5 - wrapper: the tool it called failed' }
        255        { return 'exit 255 - often the Claude CLI exiting non-zero on success; CHECK THE ARTIFACT' }
        267009     { return 'currently running' }
        267011     { return 'HAS NEVER RUN' }
        267014     { return 'terminated (by user or timeout)' }
        2147942401 { return 'file not found (0x80070002-family)' }
        2147943645 { return 'the service did not respond (0x8007041D)' }
        2147946720 { return 'NO INTERACTIVE SESSION (0x800710E0) - cannot start on a headless box' }
        default    { return ("exit " + $code) }
    }
}

# Pull a plausible file path out of an action and test it. Actions look like:
#   cmd.exe /c "C:\...\auto_daily.bat"
#   node.exe tasks\plan_monitor.cjs --quiet      (+ WorkingDirectory)
#   powershell -NoProfile -File C:\...\x.ps1
function Resolve-ActionTarget($action) {
    $args = "" + $action.Arguments
    $wd = "" + $action.WorkingDirectory
    if (-not $wd) { $wd = $Proj }

    $candidates = @()
    # Quoted paths first, then bare tokens that look like files.
    foreach ($m in [regex]::Matches($args, '"([^"]+)"')) { $candidates += $m.Groups[1].Value }
    foreach ($t in ($args -split '\s+')) {
        if ($t -match '\.(bat|cmd|ps1|cjs|js|py|exe)$') { $candidates += $t.Trim('"') }
    }
    # The executable itself matters when it is a script rather than a shell.
    if ($action.Execute -match '\.(bat|cmd|ps1|cjs|js|py)$') { $candidates += $action.Execute }

    foreach ($c in $candidates) {
        if (-not $c) { continue }
        $p = $c
        if (-not [System.IO.Path]::IsPathRooted($p)) { $p = Join-Path $wd $c }
        return [pscustomobject]@{ Path = $p; Exists = (Test-Path $p); Checked = $true }
    }
    return [pscustomobject]@{ Path = $action.Execute; Exists = $true; Checked = $false }
}

$tasks = @(Get-ScheduledTask | Where-Object {
    $_.TaskName -like 'SmartEntry*' -or $_.TaskName -like 'JARVIS*'
} | Sort-Object TaskName)

Write-Host ("  TASKS: " + $tasks.Count + " registered")
Write-Host ''

$broken = @()
$neverRun = @()
$cannotFire = @()
$now = Get-Date

foreach ($t in $tasks) {
    $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -ErrorAction SilentlyContinue
    $name = $t.TaskName
    $state = $t.State
    $result = if ($info) { Decode-Result([long]$info.LastTaskResult) } else { 'no info' }

    $age = ''
    if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 1999) {
        $hrs = [math]::Round(($now - $info.LastRunTime).TotalHours, 1)
        $age = "$hrs h ago"
    } else { $age = 'never' }

    $next = if ($info -and $info.NextRunTime) { $info.NextRunTime.ToString('MM-dd HH:mm') } else { 'none' }

    # Can the triggers fire on this box at all?
    $trigTypes = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName })
    $logonOnly = ($trigTypes.Count -gt 0) -and
                 (@($trigTypes | Where-Object { $_ -notmatch 'Logon|SessionState' }).Count -eq 0)

    # Does its action point at something that exists?
    $targets = @($t.Actions | ForEach-Object { Resolve-ActionTarget $_ })
    $missing = @($targets | Where-Object { $_.Checked -and -not $_.Exists })

    $flag = 'OK  '
    $notes = @()
    if ($missing.Count -gt 0) {
        $flag = 'BROKEN'
        $notes += ("TARGET MISSING: " + ($missing | ForEach-Object { $_.Path }) -join '; ')
        $broken += $name
    }
    if ($state -eq 'Disabled') { $flag = 'OFF '; $notes += 'disabled' }
    if ($info -and [long]$info.LastTaskResult -eq 267011) { $neverRun += $name; $notes += 'never run' }
    if ($logonOnly -and $IsHeadless) {
        # NOT 'BROKEN'. Several of these are RUNNING right now, started when a session
        # once existed, and calling a working process broken is the kind of false red
        # that trains people to skim the report. The real fault is narrower and worse:
        # if it ever STOPS, this task cannot restart it.
        if ($state -ne 'Running') { $flag = 'DEAD' } else { $flag = 'NORSTRT' }
        $notes += 'LOGON-ONLY on a headless box - if this ever stops, THIS TASK CANNOT RESTART IT'
        $cannotFire += $name
    } elseif ($logonOnly) {
        $notes += 'logon/unlock triggered - no fixed next run, fires on logon'
    }

    $line = "  [{0}] {1}" -f $flag, $name.PadRight(32)
    Write-Host $line
    Write-Host ("           state=$state  last=$age  result=$result  next=$next")
    foreach ($n in $notes) { Write-Host ("           ! " + $n) }
}

# -- Artifacts the autonomy is supposed to PRODUCE --------------------------
# A task exiting 0 and a task doing its job are different facts. These are the
# outputs, checked on disk.
Write-Host ''
Write-Host '  ARTIFACTS  (a task can exit 0 and still produce nothing)'

function Report-Artifact([string]$label, [string]$path, [int]$staleHours) {
    if (-not (Test-Path $path)) {
        Write-Host ("    MISSING  " + $label.PadRight(26) + " " + $path)
        return
    }
    $item = Get-Item $path
    $hrs = [math]::Round(((Get-Date) - $item.LastWriteTime).TotalHours, 1)
    $tag = if ($hrs -gt $staleHours) { 'STALE  ' } else { 'fresh  ' }
    Write-Host ("    " + $tag + $label.PadRight(26) + " " + $hrs + "h old, " + $item.Length + " bytes")
}

$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
Report-Artifact 'daily plan (today, UTC)' (Join-Path $Proj ("tasks\daily_plan_" + $today + ".json")) 26
Report-Artifact 'plan scorecard'          (Join-Path $Proj 'tasks\analysis\plan-scorecard.json') 30
Report-Artifact 'plan monitor state'      (Join-Path $Proj 'tasks\analysis\plan-monitor-state.json') 3
Report-Artifact 'rejection ledger'        (Join-Path $Proj 'tasks\rejections.jsonl') 30
Report-Artifact 'coverage audit log'      (Join-Path $Proj 'tasks\logs\coverage_audit.txt') 30

# Weekly review: newest weekly_*.txt, whatever it is called.
$weekly = Get-ChildItem (Join-Path $Proj 'tasks\logs') -Filter 'weekly_*.txt' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($weekly) {
    $d = [math]::Round(((Get-Date) - $weekly.LastWriteTime).TotalDays, 1)
    $tag = if ($d -gt 8) { 'STALE  ' } else { 'fresh  ' }
    Write-Host ("    " + $tag + "weekly review".PadRight(26) + " " + $weekly.Name + ", " + $d + "d old")
} else {
    Write-Host ("    MISSING  " + "weekly review".PadRight(26) + " no tasks\logs\weekly_*.txt")
}

# Daily plan coverage over the last 14 days - the number that exposed a 43% miss.
$have = 0
for ($i = 1; $i -le 14; $i++) {
    $d = (Get-Date).ToUniversalTime().AddDays(-$i).ToString('yyyy-MM-dd')
    if (Test-Path (Join-Path $Proj ("tasks\daily_plan_" + $d + ".json"))) { $have++ }
}
$pct = [math]::Round(100.0 * $have / 14)
Write-Host ("    " + "daily plan coverage".PadRight(34) + " " + $have + " of the last 14 days (" + $pct + "%)")

Write-Host ''
Write-Host '--------------------------------------------------------------------------'
Write-Host ("  " + $tasks.Count + " tasks: " + $broken.Count + " with a MISSING TARGET, " + $cannotFire.Count + " that cannot self-restart, " + $neverRun.Count + " never run")
if ($broken.Count)     { Write-Host ("  BROKEN     : " + ($broken -join ', ')) }
if ($cannotFire.Count) { Write-Host ("  CANNOT RESTART (logon-only, headless): " + ($cannotFire -join ', ')) }
if ($neverRun.Count)   { Write-Host ("  NEVER RUN  : " + ($neverRun -join ', ')) }
Write-Host '  Read-only. Nothing was registered, started, changed or deleted.'
Write-Host '=========================================================================='
exit 0
