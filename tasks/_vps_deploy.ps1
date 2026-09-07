# Deploy the sizing.js duplicate-guard fix to the VPS and restart the server.
#
# Deliberately a FILE COPY, not a git pull: the VPS is ahead 38 / behind 46 with the
# same logical commits duplicated under different SHAs on both boxes. Reconciling
# that history is a separate job and not something to attempt around a live trading
# server. The staged files were copied in by scp before this runs.
#
# git and node write to stderr on success and PS 5.1 turns that into a terminating
# NativeCommandError, so never stop on one.
$ErrorActionPreference = 'Continue'

$proj    = 'C:\ai-trading-dashboard'
$stamp   = Get-Date -Format 'yyyyMMdd_HHmmss'
$sizing  = Join-Path $proj 'server\sizing.js'
$test    = Join-Path $proj 'server\sizing.test.js'
$staged  = Join-Path $proj 'tasks\_staged_sizing.js'
$stagedT = Join-Path $proj 'tasks\_staged_sizing.test.js'

foreach ($f in @($staged, $stagedT)) {
    if (-not (Test-Path $f)) { Write-Output ("ABORT: staged file missing - " + $f); exit 1 }
}

# Back up rather than overwrite blind. Nothing is deleted.
Copy-Item $sizing  ($sizing + '.bak-' + $stamp) -Force
Copy-Item $test    ($test   + '.bak-' + $stamp) -Force
Write-Output ("backed up sizing.js and sizing.test.js with suffix .bak-" + $stamp)

Copy-Item $staged  $sizing -Force
Copy-Item $stagedT $test   -Force
Write-Output 'copied new sizing.js and sizing.test.js into place'

Write-Output ''
Write-Output '=== syntax ==='
& node --check $sizing
if ($LASTEXITCODE -ne 0) { Write-Output 'ABORT: sizing.js failed node --check - restoring backup'; Copy-Item ($sizing + '.bak-' + $stamp) $sizing -Force; exit 1 }
Write-Output '  sizing.js OK'

Write-Output ''
Write-Output '=== guard now reads ==='
$hits = Select-String -Path $sizing -Pattern 'const held = positions\.find', 'p\.direction === direction'
foreach ($h in $hits) { Write-Output ("  L{0}: {1}" -f $h.LineNumber, $h.Line.Trim()) }

Write-Output ''
Write-Output '=== test suite ==='
Push-Location (Join-Path $proj 'server')
$out = & node sizing.test.js 2>&1
Pop-Location
$out | Select-String -Pattern 'total:|passed:|failed:|result:|Gold hedge|opposite-direction|already holding' | ForEach-Object { Write-Output ('  ' + $_.Line.Trim()) }
