# PreToolUse security gate — runs before every Edit/Write
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
        Write-Error "JARVIS SECURITY BLOCK: $filePath is a protected secrets file. Never edit directly — update env vars instead."
        exit 2
    }
}

exit 0
