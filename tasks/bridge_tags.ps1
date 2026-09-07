# Which MT5 bridge tags does THIS machine own.
#
# Single source of truth: MT5_EXPECTED_ACCOUNTS in keys.env -- the same variable the
# server's healer reads, so "what we start" and "what we alarm about missing" can
# never disagree.
#
# Local Bridge B and the VPS's Bridge A were both pinned to login 11581419 and both
# running --auto against separate circuit breakers, so that one account absorbed six
# consecutive losses before both halted, allowed 15 trades a day across the two caps,
# and had its trade record split in half between two journals. One bridge per account
# across the fleet is the fix.
#
# This lives in its own file because the logic had exactly one copy, inside
# ensure_running.ps1, and tasks\startup_all.ps1 hardcoded @('A','B') instead of
# calling it -- so the scheduled safety net honoured the flag while the logon script
# beside it quietly started B again on 2026-08-07 AND 2026-08-08. A second copy would
# have drifted the same way. Dot-source this; do not paste it.
#
# Falls back to 'A,B' on a missing file, an unreadable one, or an empty value. Never
# falls back to an empty list: that would silently start no bridges at all, which is a
# worse failure than starting one too many.

function Get-ExpectedBridgeTags {
    param(
        # Defaults to the parent of the folder holding this file, so neither caller has
        # to pass a path and neither can pass a wrong one. The laptop keeps the project
        # under C:\Users\User and the VPS at C:\ai-trading-dashboard.
        [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
    )
    $fallback = @('A', 'B')
    try {
        if (-not $ProjectRoot) { return $fallback }
        $envFile = Join-Path $ProjectRoot 'keys.env'
        if (-not (Test-Path $envFile)) { return $fallback }
        $line = Select-String -Path $envFile -Pattern '^\s*MT5_EXPECTED_ACCOUNTS\s*=' -ErrorAction Stop |
                Select-Object -First 1
        if (-not $line) { return $fallback }
        $tags = ($line.Line -replace '^\s*MT5_EXPECTED_ACCOUNTS\s*=', '').Trim() -split ',' |
                ForEach-Object { $_.Trim().ToUpper() } | Where-Object { $_ }
        if (-not $tags -or $tags.Count -eq 0) { return $fallback }
        return $tags
    } catch {
        return $fallback
    }
}
