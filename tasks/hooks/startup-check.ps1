# SessionStart quality gate -- verifies the environment is ready
# Runs async so it never blocks startup, but logs issues clearly.

$proj = 'C:\Users\User\ai-trading-dashboard'
$warn = @()

# 1. Node available
$nodeVer = node --version 2>$null
if (-not $nodeVer) { $warn += "MISSING: node.exe not found in PATH" }

# 2. Python available -- and RUNNABLE, which is not the same question.
# On 2026-08-23 a python.exe sat first on PATH and could not spawn: Smart App Control
# had begun blocking the unsigned uv interpreter it pointed at. Every python call on
# the box died for 8h32m, and a PATH check would have reported nothing missing.
$resolver = Join-Path $proj 'tasks\resolve_python.ps1'
$pyBin = if (Test-Path $resolver) { & $resolver } else { $null }
if (-not $pyBin) { $warn += "MISSING: no python on this box will run (PATH order? Smart App Control?)" }

# 3. Git available
$gitVer = git --version 2>$null
if (-not $gitVer) { $warn += "MISSING: git not found in PATH" }

# 4. On correct branch
$branch = git -C $proj rev-parse --abbrev-ref HEAD 2>$null
if ($branch -and $branch -ne 'claude/backup-deploy-server-FWgpv' -and $branch -ne 'main') {
    $warn += "BRANCH: currently on '$branch' -- expected 'claude/backup-deploy-server-FWgpv'"
}

# 5. Uncommitted changes check (safety awareness)
$dirty = git -C $proj status --porcelain 2>$null
if ($dirty) {
    $count = ($dirty | Measure-Object -Line).Lines
    $warn += "GIT: $count uncommitted file(s) -- commit before editing"
}

# 6. Server reachable
$sig = curl.exe -s --max-time 3 http://localhost:3001/api/signals 2>$null
if (-not $sig) {
    $warn += "SERVER: localhost:3001 offline -- run tasks\menu.bat option S"
}

# 7. Secrets not tracked
$secrets = git -C $proj ls-files -- 'server/apikey.txt' 'keys.env' 2>$null
if ($secrets) {
    $warn += "SECURITY: SECRET FILE TRACKED BY GIT: $secrets -- remove immediately"
}

# 8. CLAUDE.md claims still true?
# This file is the first thing every session reads, and a wrong fact in it does not
# cost a minute -- it sets the agenda for the whole session. Four stale claims were
# found here on 2026-09-02, one of which sent sessions to an endpoint that does not
# exist. Exit 1 means drift; exit 2 means the checker itself broke and is reported
# separately, because a crashed checker must never read as a clean run.
$claimsOut = & node (Join-Path $proj 'tasks\claims_check.cjs') 2>&1
switch ($LASTEXITCODE) {
    1 {
        $staleCount = ([regex]::Match(($claimsOut -join "`n"), 'STALE \((\d+)\)')).Groups[1].Value
        $warn += "CLAUDE.md: $staleCount stale claim(s) -- run: node tasks\claims_check.cjs"
    }
    2 { $warn += "CLAUDE.md: claims_check FAILED to run -- not a clean result" }
}

# Output -- only if there are warnings
if ($warn.Count -gt 0) {
    Write-Host ""
    Write-Host "=== STARTUP WARNINGS ===" -ForegroundColor Yellow
    foreach ($w in $warn) {
        Write-Host "  ! $w" -ForegroundColor Yellow
    }
    Write-Host "========================" -ForegroundColor Yellow
    Write-Host ""
}
