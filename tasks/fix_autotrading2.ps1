# Second attempt at enabling MT5 AutoTrading on the VPS.
#
# Attempt 1 failed because Stop-Process -Force silently did not kill terminal64
# (PID 4032 survived, uptime unchanged since 07/26). -ErrorAction SilentlyContinue
# hid whatever refused it. This uses taskkill, then VERIFIES the process is gone by
# creation time rather than trusting the call - a kill that quietly failed is what
# made the previous run look successful while trade_allowed stayed False.
#
# A forced kill also means MT5 never runs its clean-shutdown config write, so the
# Enabled=1 already on disk survives instead of being overwritten from memory.
#
# Bridge is stopped only for the terminal swap and restarted at the end.

$ErrorActionPreference = 'Continue'
$log = 'C:\ai-trading-dashboard\tasks\logs\fix_autotrading.txt'
$ini = 'C:\Users\Administrator\AppData\Roaming\MetaQuotes\Terminal\D0E8209F77C8CF37AD8BF550E51FF075\config\common.ini'
$exe = 'C:\Program Files\MetaTrader 5\terminal64.exe'

function Note($m) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m
    Add-Content -Path $log -Value $line
    Write-Output $line
}

function Get-ExpertsEnabled {
    $bytes = [System.IO.File]::ReadAllBytes($ini)
    $isUtf16 = ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE)
    $enc = if ($isUtf16) { [System.Text.Encoding]::Unicode } else { [System.Text.Encoding]::UTF8 }
    $inExperts = $false
    foreach ($l in ([System.IO.File]::ReadAllText($ini, $enc) -split "`r`n")) {
        $t = $l.Trim()
        if ($t -match '^\[.+\]$') { $inExperts = ($t -eq '[Experts]'); continue }
        if ($inExperts -and $t -match '^Enabled\s*=\s*(\d)') { return $matches[1] }
    }
    return 'not-found'
}

Note '=== attempt 2: taskkill + verified restart ==='

# --- 1. stop bridge ---------------------------------------------------------
schtasks /end /tn "SmartEntryBridgeA" 2>&1 | Out-Null
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like '*mt5_bridge*' } |
    ForEach-Object { Note ('killing bridge PID ' + $_.ProcessId); taskkill /F /PID $_.ProcessId 2>&1 | Out-Null }
Start-Sleep -Seconds 2

# --- 2. kill the terminal, and PROVE it died --------------------------------
$before = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'"
foreach ($p in $before) {
    Note ('taskkill terminal64 PID ' + $p.ProcessId + ' (started ' + $p.CreationDate + ')')
    $out = & taskkill /F /PID $p.ProcessId 2>&1
    Note ('   taskkill said: ' + ($out -join ' '))
}

$gone = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process terminal64 -ErrorAction SilentlyContinue)) { $gone = $true; break }
}
Note ('terminal64 gone: ' + $gone)
if (-not $gone) {
    Note 'ABORT - terminal would not die; restarting bridge and leaving system as found'
    schtasks /run /tn "SmartEntryBridgeA" | Out-Null
    exit 1
}

# --- 3. confirm the config survived the kill --------------------------------
Note ('[Experts] Enabled on disk = ' + (Get-ExpertsEnabled))

# --- 4. relaunch ------------------------------------------------------------
Note 'starting terminal64'
Start-Process -FilePath $exe
Start-Sleep -Seconds 30
$t2 = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'"
if ($t2) { foreach ($p in $t2) { Note ('terminal64 up: PID ' + $p.ProcessId + ' started ' + $p.CreationDate) } }
else     { Note 'terminal64 DID NOT START' }

# --- 5. bridge back on ------------------------------------------------------
Note 'restarting bridge A'
schtasks /run /tn "SmartEntryBridgeA" | Out-Null
Start-Sleep -Seconds 12
$b = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*mt5_bridge*' }
Note ('bridge running: ' + $(if ($b) { 'YES PID ' + ($b.ProcessId -join ',') } else { 'NO' }))
Note '=== attempt 2 complete ==='
