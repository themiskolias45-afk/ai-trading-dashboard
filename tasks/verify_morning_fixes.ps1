# Verifies the three changes made 2026-09-01, the morning after they take effect.
# READ-ONLY: it starts nothing, changes no setting, and places no order. Writes only
# its own report.
#
#   powershell -File tasks\verify_morning_fixes.ps1 [-Repo C:\path]
#
# Runs on either box. Each check states what it MEASURED, not what it assumes -- a
# green tick with no number behind it is what let three jobs report red for weeks.
param([string]$Repo = "")
$ErrorActionPreference = "SilentlyContinue"

$repo = if ($Repo) { $Repo }
        elseif (Test-Path "C:\Users\User\ai-trading-dashboard\server\index.js") { "C:\Users\User\ai-trading-dashboard" }
        else { "C:\ai-trading-dashboard" }
$out = "$repo\tasks\logs\verify_morning_fixes.txt"
New-Item -ItemType Directory -Path (Split-Path $out) -Force | Out-Null

function W($s) { Write-Output $s; Add-Content -Path $out -Value $s -Encoding utf8 }
Set-Content -Path $out -Value "" -Encoding utf8
W ("VERIFY MORNING FIXES  " + (Get-Date).ToUniversalTime().ToString("s") + "Z   host " + $env:COMPUTERNAME)
W ("repo " + $repo)
W ("=" * 78)

# ---- 1. Did the Morning Agent read the brief, and did it stop re-raising? ----
W ""
W "1) MORNING AGENT -- does it now read ai_brief.md, and has it stopped re-deriving?"
# ASK THE SCHEDULER which file it actually runs. Guessing by filename reported the
# fix "missing" on the laptop, because the repo carries morning_agent_vps.bat too
# while the laptop's task runs morning_agent.bat. Checking the wrong file is exactly
# how a patch reads as applied on one box and absent on the other.
$bat = $null
foreach ($tn in @('JARVIS Morning Agent','SmartEntryMorningAgent')) {
  $tk = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
  if (-not $tk) { continue }
  $arg = ($tk.Actions | ForEach-Object { $_.Arguments }) -join ' '
  $m = [regex]::Match($arg, '[A-Za-z]:[^"]*morning_agent[^"]*\.bat')
  if ($m.Success) { $bat = $m.Value; break }
}
if (-not $bat) { $bat = "$repo\tasks\morning_agent.bat" }
$hasBrief = (Select-String -Path $bat -Pattern 'ai_brief\.md' -Quiet)
W ("   script          : " + (Split-Path $bat -Leaf))
W ("   reads ai_brief   : " + $(if ($hasBrief) { "YES" } else { "NO  <-- the fix is not on this box" }))
$prop = "$repo\tasks\logs\morning_proposals.txt"
if (Test-Path $prop) {
  $today = (Get-Date).ToString("yyyy-MM-dd")
  $reraise = @(Select-String -Path $prop -Pattern 'same fix proposed|still not applied')
  W ("   'already proposed' phrases in the whole file: " + $reraise.Count + "   (was 4 on 2026-09-01)")
  W ("   -> if this has NOT grown, the agent stopped re-deriving.")
} else { W "   morning_proposals.txt absent" }

# ---- 2. Do the AI jobs still report FAILING? ----
W ""
W "2) AI JOBS -- exit codes after raising the VPS limit to PT72H"
foreach ($n in @('SmartEntry - Daily Check','SmartEntryDailyCheck','JARVIS Morning Agent','SmartEntryMorningAgent')) {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if (-not $t) { continue }
  $i = $t | Get-ScheduledTaskInfo
  $ok = ($i.LastTaskResult -eq 0)
  W ("   {0,-26} rc={1,-6} last={2}  {3}" -f $t.TaskName, $i.LastTaskResult, $i.LastRunTime, $(if ($ok) { "CLEAN" } else { "STILL NON-ZERO" }))
  W ("        ExecTimeLimit=" + $t.Settings.ExecutionTimeLimit)
}
# The .bat writes [exit N] as its LAST line. Its absence means the bat died early,
# which is the whole 255 question -- the exit code alone cannot tell you that.
$dlog = Get-ChildItem "$repo\tasks\logs" -Filter "daily_2026*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($dlog) {
  $e = Select-String -Path $dlog.FullName -Pattern '\[exit ' | Select-Object -Last 1
  W ("   newest daily log : " + $dlog.Name + "  -> " + $(if ($e) { $e.Line.Trim() + "   (bat reached its last line)" } else { "NO [exit] LINE -- the bat still dies early" }))
}

# ---- 3. Is risk-based sizing actually producing constant risk? ----
W ""
W "3) SIZING -- is 1R the same cash on every NEW position?"
$py = if (Test-Path "$repo\.venv-rag\Scripts\python.exe") { "python" } else { "python" }
$r = & $py "$repo\tasks\pos_risk.py" $repo 2>&1
foreach ($line in $r) { if ($line -match 'RISK=|SPREAD|SIZING MODE|CONSISTENT|STILL UNEVEN|positions:') { W ("   " + $line) } }
W ("   NOTE: positions opened before 2026-09-01 15:01 keep their old size forever.")
W ("         Judge this on fills opened AFTER that timestamp only.")

W ""
W ("=" * 78)
W ("report written to " + $out)
