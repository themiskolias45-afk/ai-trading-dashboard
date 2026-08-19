# Read-only probe of the VPS sizing.js duplicate guard and server state.
# git writes progress to stderr and PS 5.1 turns that into a terminating
# NativeCommandError even on exit 0, so never let this script stop on one.
$ErrorActionPreference = 'Continue'
$proj = 'C:\ai-trading-dashboard'
$sizing = Join-Path $proj 'server\sizing.js'

Write-Output '=== sizing.js duplicate guard ==='
if (Test-Path $sizing) {
    $hits = Select-String -Path $sizing -Pattern 'p\.direction === direction', 'const held = positions\.find', 'Already holding'
    foreach ($h in $hits) { Write-Output ("  L{0}: {1}" -f $h.LineNumber, $h.Line.Trim()) }
    Write-Output ("  sha256: " + (Get-FileHash $sizing -Algorithm SHA256).Hash)
} else {
    Write-Output '  sizing.js NOT FOUND'
}

Write-Output ''
Write-Output '=== server on 3001 ==='
try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3001/api/signals' -UseBasicParsing -TimeoutSec 8
    Write-Output ("  http " + $r.StatusCode)
} catch {
    Write-Output ('  unreachable: ' + $_.Exception.Message)
}
$owner = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($owner) {
    $p = Get-Process -Id $owner.OwningProcess -ErrorAction SilentlyContinue
    Write-Output ("  port 3001 held by PID " + $owner.OwningProcess + " (" + $(if ($p) { $p.ProcessName } else { 'unknown' }) + ")")
} else {
    Write-Output '  nothing listening on 3001'
}

Write-Output ''
Write-Output '=== scheduled task for the server ==='
Get-ScheduledTask -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -match 'SmartEntry' } |
    ForEach-Object { Write-Output ("  {0}  [{1}]" -f $_.TaskName, $_.State) }
