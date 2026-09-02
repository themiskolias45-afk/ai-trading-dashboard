# PostToolUse quality gate -- runs after every Edit/Write (NOT async -- Claude sees all output)
# Checks: sensitive file protection, syntax, security scan, targeted commit

param()

$raw = try { [System.Console]::In.ReadToEnd() } catch { '' }
$j   = try { $raw | ConvertFrom-Json } catch { $null }
if (-not $j) { exit 0 }

$filePath = $j.tool_input.file_path
if (-not $filePath) { exit 0 }

$root = 'C:\Users\User\ai-trading-dashboard'
Set-Location $root

# Resolve to absolute path
if (-not [System.IO.Path]::IsPathRooted($filePath)) {
    $filePath = Join-Path $root ($filePath -replace '/', '\')
}
$filePath = $filePath -replace '/', '\'
if (-not (Test-Path $filePath)) { exit 0 }

$rel = $filePath.Replace($root + '\', '')

# -- 1. SENSITIVE FILE GUARD ----------------------------------------------------
$blocked = @('server\apikey.txt','keys.env','keys.env.local','.env','keys.env.backup')
foreach ($b in $blocked) {
    if ($rel -ieq $b) {
        Write-Error "JARVIS SECURITY BLOCK: $rel must NEVER be committed. Edit aborted."
        exit 1
    }
}

# -- 2. SYNTAX CHECK -----------------------------------------------------------
if ($filePath -match '\.js$') {
    $out = & node --check $filePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "SYNTAX ERROR -- $rel`:`n$out`nJARVIS: Fix syntax before continuing."
        exit 1
    }
}
elseif ($filePath -match '\.py$') {
    # Resolved by RUNNING a candidate, never taken from PATH -- see
    # server/python_path.js. A py_compile that cannot start is not a passing check.
    $resolver = Join-Path $PSScriptRoot '..\resolve_python.ps1'
    $pyBin = if (Test-Path $resolver) { & $resolver } else { $null }
    if (-not $pyBin) {
        Write-Error "NO PYTHON - cannot syntax-check $rel. Resolve the interpreter first."
        exit 1
    }
    $out = & $pyBin -m py_compile $filePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "SYNTAX ERROR -- $rel`:`n$out`nJARVIS: Fix syntax before continuing."
        exit 1
    }
}

# -- 3. SECURITY SCAN ----------------------------------------------------------
if ($filePath -match '\.(js|py|ts|json)$') {
    $content = try { Get-Content $filePath -Raw } catch { '' }
    if ($content -match 'sk-ant-[A-Za-z0-9\-_]{20,}') {
        Write-Error "SECURITY: Anthropic API key hardcoded in $rel -- use env var."
        exit 1
    }
    if ($content -match 'AKIA[0-9A-Z]{16}') {
        Write-Error "SECURITY: AWS access key hardcoded in $rel."
        exit 1
    }
    if ($content -match 'ghp_[A-Za-z0-9]{36}') {
        Write-Error "SECURITY: GitHub token hardcoded in $rel."
        exit 1
    }
}

# -- 3b. CODE REVIEW + EVIDENCE GATE -- MUST print before anything that can exit ---
# This ran LAST until 2026-09-02 and therefore never ran at all on server\index.js:
# section 4b exits 1 on an API shape diff, and the gate-health baseline had been stale
# since 2026-08-31 (SETUP_DISABLED, e9ae4b2), so every edit died above these lines. The
# gate built to stop unvalidated signal-path work was itself unreachable. Anything that
# must reach JARVIS goes ABOVE the first exit, not below the last one.
$tradingFiles = @('server\index.js','server\autohealer.js','mt5_bridge.py','parallel_analysis.py')
$isTrading = ($tradingFiles | Where-Object { $rel -ieq $_ }).Count -gt 0
if ($isTrading) {
    Write-Host ""
    Write-Host ">>> CODE REVIEW REQUIRED: $rel is a trading logic file." -ForegroundColor Cyan
    Write-Host ">>> JARVIS: invoke the code-reviewer agent on the changed function(s) before declaring done." -ForegroundColor Cyan
    Write-Host ">>> Auto-commit SKIPPED. Run: git add $rel && git commit -m '...' after review passes." -ForegroundColor Cyan
    Write-Host ">>> EVIDENCE GATE: this is the signal path. It does not ship on reasoning." -ForegroundColor Cyan
    Write-Host ">>>   run_walkforward must CLEAR it first, and the result goes in the commit message." -ForegroundColor Cyan
    Write-Host ">>>   Precedent 8f69319: 'REVERT every engine change from today -- the walk-forward" -ForegroundColor Cyan
    Write-Host ">>>   killed all of them.' A whole day's engine work, all of it wrong, none of it" -ForegroundColor Cyan
    Write-Host ">>>   detectable by reading the code. 514 commits have touched this logic against 7" -ForegroundColor Cyan
    Write-Host ">>>   closed trades of evidence -- so assume unvalidated until measured." -ForegroundColor Cyan
    Write-Host ""
}

# -- 4. RUN TESTS (if server/index.js changed and tests exist) -----------------
if ($rel -match '^server\\index\.js$') {
    $pkg = Join-Path $root 'server\package.json'
    if (Test-Path $pkg) {
        $p = Get-Content $pkg | ConvertFrom-Json
        $testScript = $p.scripts.test
        if ($testScript -and $testScript -notmatch 'no test') {
            Write-Host "JARVIS: Running server tests..."
            $testOut = & npm test --prefix "$root\server" 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Error "TESTS FAILED after editing $rel`:`n$testOut"
                exit 1
            }
            Write-Host "JARVIS: Tests passed."
        }
    }

    # -- 4b. API SHAPE CHECK -- catches endpoint contract regressions -----------
    $snapshot = Join-Path $root 'tasks\api_snapshot.cjs'
    if (Test-Path $snapshot) {
        Write-Host "JARVIS: Checking API shape..."
        $snapOut = & node $snapshot 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error "API SHAPE REGRESSION -- $rel changed an endpoint shape:`n$snapOut`nJARVIS: Restore the endpoint contract before committing. This BLOCKS NOTHING -- the edit is already on disk, the server is untouched, and no signal, gate or learning path is affected. It is a report."
            exit 1
        }
        Write-Host "JARVIS: API shape OK."
    }
}

# -- 5. COMMIT -- specific file only, never git add -A -------------------------
# Trading-logic files are NEVER auto-committed: code review must pass first.
# $tradingFiles / $isTrading are set in section 3b above.
if (-not $isTrading) {
    if (git status --porcelain 2>$null) {
        $fileStatus = git status --porcelain $rel 2>$null
        if ($fileStatus) {
            git add $rel 2>$null
            git commit -m "update $rel" --quiet 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "JARVIS: $rel committed -- syntax OK, security OK."
            }
        }
    }
}

exit 0
