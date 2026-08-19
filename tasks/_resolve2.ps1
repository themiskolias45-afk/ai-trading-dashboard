$ErrorActionPreference = 'Continue'
Set-Location 'C:\ai-trading-dashboard'

$path = 'C:\ai-trading-dashboard\mt5_bridge.py'
$normalised = ([System.IO.File]::ReadAllText($path)) -replace "`r`n", "`n"

# Both sides belong: `math` came with the trailing-stop ladder (applied here first),
# `threading` came with the sizing commit being applied now. Order matches the laptop.
$conflict = @"
<<<<<<< HEAD
import math
=======
import threading
>>>>>>> 9493541 (Position sizing priced a lot as one unit of the instrument)
"@ -replace "`r`n", "`n"

if ($normalised -notlike "*$conflict*") {
    Write-Output 'RESOLVE_FAIL: conflict hunk not found verbatim'
    exit 1
}

$resolved = $normalised.Replace($conflict, "import math`nimport threading")
[System.IO.File]::WriteAllText($path, $resolved, (New-Object System.Text.UTF8Encoding($false)))

if ((Get-Content $path -Raw) -match '<<<<<<<|>>>>>>>') {
    Write-Output 'RESOLVE_FAIL: markers remain'
    exit 1
}

Write-Output 'RESOLVE_OK'
Get-Content $path -TotalCount 22 | Select-Object -Skip 11
