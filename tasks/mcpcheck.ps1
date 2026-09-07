$ErrorActionPreference = 'Continue'
$j = Get-Content "$env:USERPROFILE\.claude.json" -Raw | ConvertFrom-Json
Write-Output "=== VPS mcpServers ==="
if ($j.mcpServers) { $j.mcpServers.PSObject.Properties.Name | ForEach-Object { "  - $_" } } else { Write-Output "  (NONE)" }
Write-Output "=== VPS logged in? ==="
Write-Output ("  oauthAccount present: " + [bool]$j.oauthAccount)
Write-Output "=== VPS top-level keys ==="
$j.PSObject.Properties.Name | Sort-Object | ForEach-Object { "  $_" }
