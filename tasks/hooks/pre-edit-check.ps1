# PreToolUse security gate -- runs before every Edit/Write
# Blocks edits to protected secrets files (exit 2 = block the tool call)

param()

$raw = try { [System.Console]::In.ReadToEnd() } catch { '' }
$j   = try { $raw | ConvertFrom-Json } catch { $null }
if (-not $j) { exit 0 }

$filePath = $j.tool_input.file_path
if (-not $filePath) { exit 0 }

$blocked = @('apikey\.txt$', 'keys\.env$', 'keys\.env\.local$', '(?<![a-z])\.env$')
foreach ($pattern in $blocked) {
    if ($filePath -match $pattern) {
        Write-Error "JARVIS SECURITY BLOCK: $filePath is a protected secrets file. Never edit directly -- update env vars instead."
        exit 2
    }
}

# Warn (not block) when editing high-risk trading logic files
$highRisk = @('server[/\\]index\.js$', 'server[/\\]mcp_server\.js$')
foreach ($pattern in $highRisk) {
    if ($filePath -match $pattern) {
        Write-Host ""
        Write-Host "PRE-FLIGHT REQUIRED: editing $filePath" -ForegroundColor Yellow
        Write-Host "Answer all 6 questions in tasks/pre-flight.md before this edit." -ForegroundColor Yellow
        Write-Host "Write the CHANGING/NOW/AFTER/RISK scaffold. If RISK is HIGH -- show user first." -ForegroundColor Yellow
        Write-Host ""
    }
}

exit 0
