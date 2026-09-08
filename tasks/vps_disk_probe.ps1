# Read-only probe: disk headroom and archive footprint on whichever box runs it.
# Exists as a FILE because quoting a nested PowerShell one-liner through ssh mangles
# pipes and format operators - two attempts on 2026-09-08 died on '|' and on -f before
# this was written. A script file has no quoting layer to survive.
$ErrorActionPreference = 'SilentlyContinue'

$d = Get-PSDrive C
Write-Output ("disk_free_gb=" + [math]::Round($d.Free / 1GB, 1))
Write-Output ("disk_used_gb=" + [math]::Round($d.Used / 1GB, 1))

foreach ($dir in @('C:\ai-trading-dashboard\backups', 'C:\ai-trading-dashboard\vps-backups')) {
    if (-not (Test-Path $dir)) { Write-Output ("missing=" + $dir); continue }
    $f = Get-ChildItem "$dir\*.zip"
    $sum = 0
    foreach ($x in $f) { $sum += $x.Length }
    Write-Output ("dir=" + $dir + " zips=" + $f.Count + " mb=" + [math]::Round($sum / 1MB, 0))
    if ($f.Count -gt 0) {
        $sorted = $f | Sort-Object Name
        Write-Output ("  oldest=" + $sorted[0].Name)
        Write-Output ("  newest=" + $sorted[$sorted.Count - 1].Name)
    }
}
