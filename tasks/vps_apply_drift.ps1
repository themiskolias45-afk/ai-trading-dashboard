Set-Location 'C:\ai-trading-dashboard'
$ts  = Get-Date -Format 'yyyyMMdd_HHmmss'
$bak = "C:\ai-trading-dashboard\tasks\logs\mt5_bridge.py.bak-drift-$ts"
Copy-Item 'mt5_bridge.py' $bak -Force
if (-not (Test-Path $bak)) { Write-Output 'BACKUP_FAIL - refusing to patch'; exit 1 }
Write-Output "BACKUP_OK $bak"

python 'tasks\vps_fix_drift.py' 'C:\ai-trading-dashboard\mt5_bridge.py'
if (-not $?) { Write-Output 'PATCH FAILED - file untouched'; exit 1 }

python -m py_compile mt5_bridge.py
if ($?) {
  Write-Output 'PY_COMPILE_PASSED'
} else {
  Write-Output 'PY_COMPILE_FAILED - rolling back'
  Copy-Item $bak 'mt5_bridge.py' -Force
  exit 1
}

Write-Output '--- exercise the REAL sizing lines from the patched file ---'
python -c @"
import io
src = io.open('mt5_bridge.py', encoding='utf-8').read()
i = src.index('    planned_distance  = abs(entry - stop)')
tail = '    sizing_entry  = price if size_off_fill else entry'
j = src.index(tail) + len(tail)
block = chr(10).join(l[4:] for l in src[i:j].split(chr(10)))
cases = [('BUY', 7730.0, 7694.0, 7744.71), ('BUY', 7730.0, 7694.0, 7700.0),
         ('BUY', 7730.0, 7694.0, 7690.0), ('SELL', 7730.0, 7766.0, 7715.0)]
for side, entry, stop, price in cases:
    ns = {'entry': entry, 'stop': stop, 'price': price, 'abs': abs}
    exec(block, ns)
    print('  %-5s fill %-9.2f -> sizing_entry %-9.2f  used_fill=%s'
          % (side, price, ns['sizing_entry'], ns['size_off_fill']))
"@
