<#
  _wire_sizing_audit_vps.ps1 — insert the sizing-cap audit into the VPS daily job.

  WHY A SCRIPT AND NOT AN ssh ONE-LINER. Nested quoting does not survive the hop:
  a PowerShell -Command carrying its own single and double quotes arrives mangled
  (measured on this box, 2026-09-10: MissingEndParenthesisInMethodCall). Shipping
  a file and running it removes the whole quoting layer.

  WHY Latin1 AND NOT Get-Content/Set-Content. Windows PowerShell 5.1 reads a
  BOM-less UTF-8 file as ANSI and writes it back re-encoded — on 2026-09-08 that
  added 39,417 bytes and double-encoded 13,267 lines on this very VPS, and
  `node --check` still PASSED afterwards. Encoding 28591 (Latin1) maps bytes
  0-255 to chars 1:1, so read -> modify -> write is byte-exact for every region
  this script does not deliberately touch. The inserted text is pure ASCII.

  IT REFUSES RATHER THAN GUESSES. Missing anchor, an anchor that appears more
  than once, an insert that is already present, or a byte delta that does not
  equal the inserted text exactly — any of these aborts before or after the write,
  and the backup is taken and verified before a single byte is changed.
#>

$ErrorActionPreference = 'Stop'

$Target = 'C:\ai-trading-dashboard\tasks\auto_daily_vps.bat'
$Anchor = 'node "%PROJ%\tasks\durable_state_audit.cjs" >> "%LOGFILE%" 2>&1'
$Marker = 'sizing_cap_audit.cjs'

$Insert = @'


REM How much of each order's intended risk budget actually reached the broker.
REM
REM IT GOES IN THE DAILY LOG STREAM ON PURPOSE, NOT INTO A TASK OF ITS OWN.
REM mt5_bridge.py:get_lot_size has always logged every lot truncation it performs,
REM and on 2026-09-10 a repo-wide grep for "Lot size capped" returned mt5_bridge.py
REM and NOTHING ELSE - the bridge was writing an exact record of every under-sized
REM order into a file no reader opens. On THIS box two SP500 orders carried 4.8%%
REM and 10.4%% of their intended budget, truncated 21x by maxLotSize, and nothing
REM said so. Giving this its own scheduled task would produce a second report
REM nobody reads, which is the same bug one level up. Here its output lands in
REM %LOGFILE% with the rest of the run.
REM
REM Read-only, and a failure must not stop the daily run, so output goes to the log
REM and the run continues either way. It opens no MT5 client, makes no HTTP call,
REM reads no config, gate, journal or learning file, and writes only its own
REM report - so it cannot suppress a setup, move a confidence value, or drop a
REM learning row.
node "%PROJ%\tasks\sizing_cap_audit.cjs" >> "%LOGFILE%" 2>&1
'@

function Fail([string]$why) { Write-Host "REFUSED: $why"; exit 2 }

if (-not (Test-Path $Target)) { Fail "target not found: $Target" }

$latin1   = [System.Text.Encoding]::GetEncoding(28591)
$original = [System.IO.File]::ReadAllBytes($Target)
$text     = $latin1.GetString($original)

$nonAscii = ($original | Where-Object { $_ -gt 127 }).Count
Write-Host ("target   : {0}" -f $Target)
Write-Host ("bytes    : {0}   non-ASCII: {1}" -f $original.Length, $nonAscii)

if ($text -match [regex]::Escape($Marker)) { Fail "already wired - $Marker is present. Nothing changed." }

$hits = ([regex]::Matches($text, [regex]::Escape($Anchor))).Count
if ($hits -ne 1) { Fail "anchor found $hits time(s), need exactly 1. Refusing to guess where to insert." }

# Backup BEFORE any modification, and prove it landed before continuing.
$stamp  = Get-Date -Format 'yyyyMMdd_HHmmss'
$backup = "$Target.bak-sizingaudit-$stamp"
[System.IO.File]::WriteAllBytes($backup, $original)
if (-not (Test-Path $backup)) { Fail "backup was not created at $backup" }
$backupLen = (Get-Item $backup).Length
if ($backupLen -ne $original.Length) { Fail "backup is $backupLen bytes, original is $($original.Length)" }
Write-Host ("backup   : {0}  ({1} bytes, verified)" -f $backup, $backupLen)

$patched = $text -replace [regex]::Escape($Anchor), ([System.Text.RegularExpressions.Regex]::Escape($Anchor + $Insert) -replace '\\(.)','$1')
# The -replace above is fragile with $ and \ in the payload; do it positionally instead.
$idx     = $text.IndexOf($Anchor)
$patched = $text.Substring(0, $idx + $Anchor.Length) + $Insert + $text.Substring($idx + $Anchor.Length)

[System.IO.File]::WriteAllBytes($Target, $latin1.GetBytes($patched))

# ---- verify ----
$after      = [System.IO.File]::ReadAllBytes($Target)
$afterText  = $latin1.GetString($after)
$expected   = $original.Length + $latin1.GetByteCount($Insert)
$deltaOk    = ($after.Length -eq $expected)
$markerOk   = $afterText -match [regex]::Escape($Marker)
$anchorOk   = (([regex]::Matches($afterText, [regex]::Escape($Anchor))).Count -eq 1)

# Reachability: the inserted call must sit BEFORE endlocal, or it is dead code -
# the exact trap this project already hit once, where every line after a bare
# .CMD invocation never ran.
$lines      = $afterText -split "`r?`n"
$callLine   = ($lines | Select-String -SimpleMatch $Marker | Select-Object -First 1).LineNumber
$endLine    = ($lines | Select-String -SimpleMatch 'endlocal' | Select-Object -Last 1).LineNumber
$reachable  = ($callLine -ne $null -and $endLine -ne $null -and $callLine -lt $endLine)

Write-Host ("bytes    : {0} -> {1}  (expected {2})  {3}" -f $original.Length, $after.Length, $expected, $(if ($deltaOk) {'OK'} else {'MISMATCH'}))
Write-Host ("marker   : {0}" -f $(if ($markerOk) {'present'} else {'MISSING'}))
Write-Host ("anchor   : {0}" -f $(if ($anchorOk) {'intact, still unique'} else {'DAMAGED'}))
Write-Host ("position : call at line {0}, endlocal at line {1} -> {2}" -f $callLine, $endLine, $(if ($reachable) {'REACHABLE'} else {'DEAD CODE'}))
Write-Host ("nonASCII : {0} -> {1}" -f $nonAscii, (($after | Where-Object { $_ -gt 127 }).Count))

if (-not ($deltaOk -and $markerOk -and $anchorOk -and $reachable)) {
    [System.IO.File]::WriteAllBytes($Target, $original)
    Write-Host "VERIFY FAILED - target restored from the in-memory original. No change stands."
    exit 3
}

Write-Host "WIRED OK"
exit 0
