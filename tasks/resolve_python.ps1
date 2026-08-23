# Emit the interpreter that actually RUNS on this box, or nothing.
#
#   $python = & (Join-Path $PSScriptRoot 'resolve_python.ps1')
#   if (-not $python) { $python = 'python' }   # or refuse, if the caller can
#
# ASCII ONLY - PowerShell 5.1 reads a .ps1 as ANSI without a BOM.
#
# The decision lives in server/python_path.js, the one resolver in this repo. This is a
# mouthpiece for it, so batch, PowerShell and Node cannot drift apart and start
# disagreeing about which python is real. See tasks/resolve_python.bat for the incident
# that made PATH order stop being something this system bets on.
$adapter = Join-Path $PSScriptRoot 'resolve_python.cjs'
if (-not (Test-Path $adapter)) { return }
try {
    $bin = & node $adapter 2>$null
    if ($LASTEXITCODE -eq 0 -and $bin) { "$bin".Trim() }
} catch {
    # node missing or unrunnable. Emit nothing; the caller falls back exactly as it
    # behaved before this existed.
}
