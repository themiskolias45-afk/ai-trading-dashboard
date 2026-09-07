# Patch /api/daily-plan on the VPS to send the two freshness stamps it already holds.
#
# A PATCH, not a copy. The VPS index.js carries commits this repo has never seen, so
# copying the laptop's file would silently revert them - see vps_git_history_has_diverged.
#
# ASCII ONLY. PS 5.1 reads a BOM-less .ps1 as ANSI.
#
# It is IDEMPOTENT: if the fields are already there it reports so and changes nothing.
# It backs up before writing and restores the backup if node --check fails. Nothing is
# deleted, ever.

$ErrorActionPreference = 'Continue'

$file  = 'C:\ai-trading-dashboard\server\index.js'
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

if (-not (Test-Path $file)) { Write-Output "ABORT: $file not found"; exit 1 }

$lines = [System.IO.File]::ReadAllLines($file)

if ($lines -match 'signalsUpdatedAt: signalCache\.updatedAt') {
    Write-Output 'ALREADY PATCHED: signalsUpdatedAt is present. Nothing changed.'
    exit 0
}

# Find the daily-plan route, then the generatedAt line INSIDE it. The generatedAt string
# occurs seven times in this file, so anchoring on it alone would patch the wrong route.
$routeIdx = -1
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -like '*app.get("/api/daily-plan"*') { $routeIdx = $i; break }
}
if ($routeIdx -lt 0) { Write-Output 'ABORT: /api/daily-plan route not found'; exit 1 }

$genIdx = -1
for ($i = $routeIdx; $i -lt [Math]::Min($routeIdx + 30, $lines.Length); $i++) {
    if ($lines[$i] -like '*generatedAt: new Date().toISOString(),*') { $genIdx = $i; break }
}
if ($genIdx -lt 0) { Write-Output 'ABORT: generatedAt line not found inside the route'; exit 1 }

Write-Output ("route at line " + ($routeIdx + 1) + ", generatedAt at line " + ($genIdx + 1))

$insert = @(
'    // generatedAt above is stamped WHEN THE REQUEST ARRIVES, so it always reads "now"',
'    // and can never go stale. The page rendered it as its only freshness stamp, which',
'    // meant a plan built on signals refreshed nine hours ago looked as current as one',
'    // built a minute ago. These two are the REAL ages, both already held in memory and',
'    // simply never sent. Null before the first refresh, and null must render as',
'    // "age unknown" - never as fresh. Same rule as the healer tick with no age.',
'    signalsUpdatedAt: signalCache.updatedAt,',
'    pricesUpdatedAt:  priceCache.updated,'
)

$out = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Length; $i++) {
    $out.Add($lines[$i])
    if ($i -eq $genIdx) { foreach ($l in $insert) { $out.Add($l) } }
}

$backup = $file + '.bak-dailyplanages-' + $stamp
Copy-Item $file $backup -Force
if (-not (Test-Path $backup)) { Write-Output 'ABORT: backup was not created'; exit 1 }
Write-Output ("backed up to " + $backup)

# No BOM. Set-Content -Encoding utf8 emits one and has already silently broken a config
# file on this box.
[System.IO.File]::WriteAllLines($file, $out.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("wrote " + $out.Count + " lines (was " + $lines.Length + ")")

& node --check $file
if ($LASTEXITCODE -ne 0) {
    Write-Output 'node --check FAILED - restoring backup'
    Copy-Item $backup $file -Force
    exit 1
}
Write-Output 'node --check OK'

$check = Select-String -Path $file -Pattern 'signalsUpdatedAt: signalCache\.updatedAt', 'pricesUpdatedAt:  priceCache\.updated'
Write-Output ('verified ' + $check.Count + ' inserted lines present')
exit 0
