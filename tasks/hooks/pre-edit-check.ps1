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

# -- DUPLICATE GUARD -- warn when this already exists. NEVER blocks (exit stays 0).
#
# "duplicate" appears in 67 commit messages here. 0f943e1: "I built a duplicate
# stop-variant scorer -- tasks/score_stop_variants.cjs already existed". CLAUDE.md has
# said "Always check what exists first" the whole time and it does not fire, because a
# rule enforced by remembering is enforced by nothing -- exactly what fb8b4f9 found
# about the mojibake check. This runs whether or not anyone remembers.
#
# The logic is in tasks/duplicate_check.cjs, not here, because that is testable:
#   node tasks/duplicate_check.cjs --selftest
# It regression-tests both real historical mistakes.
#
# Input goes through a temp FILE, never an argument. Embedded quotes in an argument
# get mangled by PowerShell -- the same bug that put 66 HTTP 400s in the session-stop
# hook until it switched to --data-binary "@file". Fixed path, overwritten each run,
# never deleted.
try {
    $dupScript = Join-Path $PSScriptRoot '..\duplicate_check.cjs'
    if (Test-Path $dupScript) {
        $dupInput = Join-Path $env:TEMP 'jarvis_dup_input.json'
        [System.IO.File]::WriteAllText($dupInput, $raw, (New-Object System.Text.UTF8Encoding($false)))
        $dupOut = & node $dupScript --input $dupInput 2>&1
        if ($dupOut) { Write-Error ($dupOut -join "`n") }
    }
} catch {
    # A guard must never become the reason an edit fails.
}

# -- DECISION GUARD -- this file carries a standing decision. NEVER blocks (exit stays 0).
#
# Added 2026-09-02, the day it was needed and absent. An agent edited tradingview_bot.py
# and reversed a LOCKED decision recorded at line 1185 of that same file, after a real
# 2026-08-24 incident. Nothing was hidden: the file was known, the decision was known, and
# nothing put them in front of each other. Measured the same day, 38 standing decisions
# live inside source comments across the tree, and tasks/rag_index.py indexes trades,
# shadow, memory, brain and vault -- not source. "Has this already been decided?" was an
# unanswerable question unless you already knew the filename.
#
# Same reasoning as the duplicate guard above: CLAUDE.md has said "locked decisions stay
# locked" the whole time and it does not fire, because a rule enforced by remembering is
# enforced by nothing. This runs whether or not anyone remembers.
#
# The logic is in tasks/decisions.cjs, not here, so it stays testable:
#   node tasks/decisions.cjs guard <file>     what this hook prints
#   node tasks/decisions.cjs check "<topic>"  the same question, by topic
try {
    $decScript = Join-Path $PSScriptRoot '..\decisions.cjs'
    if ((Test-Path $decScript) -and $filePath) {
        $decOut = & node $decScript guard $filePath 2>&1
        if ($decOut) { Write-Error ($decOut -join "`n") }
    }
} catch {
    # Same rule: a guard that can fail an edit becomes a thing to work around.
}

exit 0
