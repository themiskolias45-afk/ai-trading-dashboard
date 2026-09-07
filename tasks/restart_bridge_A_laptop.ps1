# Replace the running laptop bridge, then start its launcher. Refuses on anything unsafe.
# Never closes a trade and never touches an SL or TP.
$root = 'C:\Users\User\ai-trading-dashboard'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
           Where-Object { $_.CommandLine -like '*mt5_bridge*' })
if ($procs.Count -eq 0) {
  $pidFile = Join-Path $root 'tasks\logs\bridge_A.pid'
  if (Test-Path $pidFile) {
    $recorded = (Get-Content $pidFile -Raw).Trim()
    $p = Get-Process -Id $recorded -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'python') { $procs = @($p); Write-Output ("   using recorded pid " + $recorded) }
  }
}
if ($procs.Count -eq 0) { Write-Output '   NO BRIDGE PROCESS FOUND - refusing'; exit 2 }
if ($procs.Count -gt 1) { Write-Output ('   ' + $procs.Count + ' bridge processes - refusing, ambiguous'); exit 3 }
$target = $procs[0]
$id = if ($target.ProcessId) { $target.ProcessId } else { $target.Id }
Write-Output ("   stopping bridge pid " + $id)
try { Stop-Process -Id $id -Force -ErrorAction Stop }
catch { Write-Output ("   STOP FAILED: " + $_.Exception.Message); Write-Output '   bridge left RUNNING and untouched'; exit 4 }
Start-Sleep -Seconds 4
if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Write-Output '   pid SURVIVED - refusing to start a second bridge'; exit 5 }
Write-Output '   stopped cleanly'
Start-Process cmd -ArgumentList '/c','tasks\start_bridge_A.bat' -WorkingDirectory $root -WindowStyle Minimized
Start-Sleep -Seconds 14
$after = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*mt5_bridge*' })
Write-Output ("   bridge processes after: " + $after.Count)
