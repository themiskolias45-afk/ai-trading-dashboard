# Saves session summary to vault + persists key facts to MCP memory.
# Only writes when the newest commit is new — prevents duplicate noise.

$ts     = Get-Date -Format 'yyyy-MM-dd HH:mm'
$today  = Get-Date -Format 'yyyy-MM-dd'
$vault  = 'C:\Users\User\Documents\Brain\01 - Daily Notes'
$note   = "$vault\$today.md"
$proj   = 'C:\Users\User\ai-trading-dashboard'

# --- 1. Vault daily note (deduped by newest commit hash) ---
if (Test-Path $vault) {
    $commits = git -C $proj log --oneline -5 2>$null
    if ($commits) {
        $newestHash = ($commits | Select-Object -First 1).ToString().Split(' ')[0]
        $alreadyLogged = $false
        if (Test-Path $note) {
            $existing = Get-Content -Path $note -Raw -ErrorAction SilentlyContinue
            if ($existing -and $existing.Contains($newestHash)) { $alreadyLogged = $true }
        }
        if (-not $alreadyLogged) {
            $content = @"

## JARVIS Session - $ts
$($commits -join "`n")
"@
            Add-Content -Path $note -Value $content -Encoding UTF8 -ErrorAction SilentlyContinue
        }
    }
}

# --- 2. Push last 3 commits to MCP memory for next session recall ---
# Uses the SmartEntry MCP write_memory tool via HTTP since MCP isn't
# available in hook context. Falls back silently if server is offline.
$recentLog = git -C $proj log --oneline -3 2>$null
if ($recentLog) {
    $summary = $recentLog -join " | "
    $body = "{`"key`":`"last-session-commits`",`"value`":`"$summary`"}"
    curl.exe -s -X POST http://localhost:3001/api/memory `
        -H 'Content-Type: application/json' `
        -d $body `
        --max-time 3 2>$null | Out-Null
}

# --- 3. Check for uncommitted changes — warn so nothing is lost ---
$dirty = git -C $proj status --porcelain 2>$null
if ($dirty) {
    $count = ($dirty | Measure-Object -Line).Lines
    Write-Host ""
    Write-Host "WARNING: $count uncommitted file(s) when session ended. Run: git add [files] && git commit" -ForegroundColor Red
}
