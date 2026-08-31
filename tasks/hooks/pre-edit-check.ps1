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

# Warn (not block) when editing high-risk trading logic files.
# IMPORTANT: exit 0 means this edit IS PROCEEDING — this is an informational reminder,
# NOT a block condition. Do not ask the user for approval because of this message.
# Stop the edit yourself ONLY if the RISK assessment says HIGH and you have not shown it to the user.
$highRisk = @('server[/\\]index\.js$', 'server[/\\]mcp_server\.js$')
foreach ($pattern in $highRisk) {
    if ($filePath -match $pattern) {
        Write-Error "PRE-FLIGHT REMINDER (edit is proceeding): $filePath — complete CHANGING/NOW/AFTER/RISK scaffold before writing. If RISK is HIGH and user has not seen it — stop the edit yourself now. This is NOT a block."
    }
}

exit 0
