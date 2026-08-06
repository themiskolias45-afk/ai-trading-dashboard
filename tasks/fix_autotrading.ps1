# Enables MetaTrader 5 AutoTrading on the VPS by writing [Experts] Enabled=1 into
# the terminal's common.ini and restarting the terminal.
#
# ORDER MATTERS. MT5 rewrites common.ini from memory when it exits, so editing the
# file under a running terminal is silently discarded. The terminal must be closed
# FIRST, then the file edited, then the terminal started.
#
# The bridge is stopped before the terminal goes down and started after it comes
# back: the bridge's mt5.initialize() handle is bound to the terminal process, and
# a terminal restart underneath it leaves every call returning None with nothing
# raised - a live process talking to a dead handle.
#
# Open positions are broker-side state and are unaffected by a terminal restart.

$ErrorActionPreference = 'Continue'
$log  = 'C:\ai-trading-dashboard\tasks\logs\fix_autotrading.txt'
$ini  = 'C:\Users\Administrator\AppData\Roaming\MetaQuotes\Terminal\D0E8209F77C8CF37AD8BF550E51FF075\config\common.ini'
$exe  = 'C:\Program Files\MetaTrader 5\terminal64.exe'

function Note($m) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m
    Add-Content -Path $log -Value $line
    Write-Output $line
}

Note '=== enabling AutoTrading ==='

# --- 1. stop the bridge -----------------------------------------------------
schtasks /end /tn "SmartEntryBridgeA" 2>&1 | Out-Null
Start-Sleep -Seconds 2
$bridges = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
           Where-Object { $_.CommandLine -like '*mt5_bridge*' }
foreach ($b in $bridges) {
    Note ('stopping bridge PID ' + $b.ProcessId)
    Stop-Process -Id $b.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Note ('bridge processes remaining: ' + (@(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*mt5_bridge*' }).Count))

# --- 2. close the terminal --------------------------------------------------
$t = Get-Process terminal64 -ErrorAction SilentlyContinue
if ($t) {
    Note ('closing terminal64 PID ' + $t.Id)
    $t.CloseMainWindow() | Out-Null
    if (-not $t.WaitForExit(20000)) {
        Note 'graceful close timed out - forcing'
        Stop-Process -Id $t.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
} else {
    Note 'terminal64 was not running'
}
Note ('terminal64 running after close: ' + (@(Get-Process terminal64 -ErrorAction SilentlyContinue).Count))

# --- 3. edit common.ini -----------------------------------------------------
if (-not (Test-Path $ini)) { Note "common.ini NOT FOUND at $ini - aborting"; exit 1 }

$backup = $ini + '.bak-' + (Get-Date -Format 'yyyyMMdd_HHmmss')
Copy-Item $ini $backup -Force
Note ("backed up common.ini -> $backup")

# Preserve the original encoding. MT5 writes this file as UTF-16LE; rewriting it
# as ASCII makes the terminal read an empty config and silently lose the login.
$bytes = [System.IO.File]::ReadAllBytes($ini)
$isUtf16 = ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE)
$enc = if ($isUtf16) { [System.Text.Encoding]::Unicode } else { [System.Text.Encoding]::UTF8 }
Note ('common.ini encoding: ' + $(if ($isUtf16) { 'UTF-16LE' } else { 'UTF-8/ANSI' }))

$text  = [System.IO.File]::ReadAllText($ini, $enc)
$lines = $text -split "`r`n"

# Section-aware: only touch Enabled/Enable inside [Experts]. Those key names also
# appear elsewhere in the file, and flipping the wrong one changes unrelated
# terminal behaviour.
$inExperts = $false
$changed   = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i].Trim()
    if ($l -match '^\[.+\]$') { $inExperts = ($l -eq '[Experts]') ; continue }
    if ($inExperts -and $l -match '^(Enabled|Enable)\s*=\s*0\s*$') {
        $key = $matches[1]
        $lines[$i] = $key + '=1'
        $changed += $key
    }
}
if ($changed.Count -eq 0) {
    Note 'no [Experts] Enabled=0 / Enable=0 lines found - already enabled or key names differ'
} else {
    [System.IO.File]::WriteAllText($ini, ($lines -join "`r`n"), $enc)
    Note ('set to 1: ' + ($changed -join ', '))
}

Note '--- [Experts] section after edit ---'
$after = [System.IO.File]::ReadAllText($ini, $enc) -split "`r`n"
$show = $false
foreach ($l in $after) {
    if ($l.Trim() -match '^\[.+\]$') { $show = ($l.Trim() -eq '[Experts]') }
    if ($show) { Note ('   ' + $l) }
}

# --- 4. restart the terminal ------------------------------------------------
Note 'starting terminal64'
Start-Process -FilePath $exe
Start-Sleep -Seconds 25
$t2 = Get-Process terminal64 -ErrorAction SilentlyContinue
Note ('terminal64 running: ' + $(if ($t2) { 'YES PID ' + $t2.Id } else { 'NO' }))
Note '=== done - verify trade_allowed next ==='
