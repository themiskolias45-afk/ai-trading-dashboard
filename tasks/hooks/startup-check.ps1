# SessionStart quality gate — verifies the environment is ready
# Runs async so it never blocks startup, but logs issues clearly.

$proj = 'C:\Users\User\ai-trading-dashboard'
$warn = @()

# 1. Node available
$nodeVer = node --version 2>$null
if (-not $nodeVer) { $warn += "MISSING: node.exe not found in PATH" }

# 2. Python available
$pyVer = python --version 2>$null
if (-not $pyVer) { $warn += "MISSING: python not found in PATH" }

# 3. Git available
$gitVer = git --version 2>$null
if (-not $gitVer) { $warn += "MISSING: git not found in PATH" }

# 4. On correct branch
$branch = git -C $proj rev-parse --abbrev-ref HEAD 2>$null
if ($branch -and $branch -ne 'claude/backup-deploy-server-FWgpv' -and $branch -ne 'main') {
    $warn += "BRANCH: currently on '$branch' — expected 'claude/backup-deploy-server-FWgpv'"
}

# 5. Uncommitted changes check (safety awareness)
$dirty = git -C $proj status --porcelain 2>$null
if ($dirty) {
    $count = ($dirty | Measure-Object -Line).Lines
    $warn += "GIT: $count uncommitted file(s) — commit before editing"
}

# 6. Server reachable
$sig = curl.exe -s --max-time 3 http://localhost:3001/api/signals 2>$null
if (-not $sig) {
    $warn += "SERVER: localhost:3001 offline — run tasks\menu.bat option S"
}

# 7. Secrets not tracked
$secrets = git -C $proj ls-files -- 'server/apikey.txt' 'keys.env' 2>$null
if ($secrets) {
    $warn += "SECURITY: SECRET FILE TRACKED BY GIT: $secrets — remove immediately"
}

# Output — only if there are warnings
if ($warn.Count -gt 0) {
    Write-Host ""
    Write-Host "=== STARTUP WARNINGS ===" -ForegroundColor Yellow
    foreach ($w in $warn) {
        Write-Host "  ! $w" -ForegroundColor Yellow
    }
    Write-Host "========================" -ForegroundColor Yellow
    Write-Host ""
}
