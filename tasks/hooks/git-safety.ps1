# Reads tool input from stdin — backs up uncommitted files before any destructive git command
$raw = [System.Console]::In.ReadToEnd()
try { $j = $raw | ConvertFrom-Json; $cmd = $j.tool_input.command } catch { exit 0 }
if ($cmd -notmatch 'git\s+(reset\s+--hard|clean\s+-[fdx]|checkout\s+--|restore\s+\.)') { exit 0 }

Set-Location 'C:\Users\User\ai-trading-dashboard'
$dirty = git status --porcelain 2>$null
if (-not $dirty) { exit 0 }

$ts  = Get-Date -Format 'yyyyMMdd_HHmmss'
$bk  = "tasks\backups\pre-git-$ts"
New-Item -ItemType Directory -Path $bk -Force | Out-Null
if (Test-Path 'dashboard') { Copy-Item 'dashboard' "$bk\dashboard" -Recurse -Force 2>$null }
if (Test-Path 'server\index.js') { Copy-Item 'server\index.js' $bk -Force 2>$null }
Write-Host "JARVIS: Uncommitted files backed up to $bk before git operation."
exit 0
