# PostToolUse quality gate — runs after every Edit/Write (NOT async — Claude sees all output)
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

# ── 1. SENSITIVE FILE GUARD ────────────────────────────────────────────────────
$blocked = @('server\apikey.txt','keys.env','keys.env.local','.env','keys.env.backup')
foreach ($b in $blocked) {
    if ($rel -ieq $b) {
        Write-Error "JARVIS SECURITY BLOCK: $rel must NEVER be committed. Edit aborted."
        exit 1
    }
}

# ── 2. SYNTAX CHECK ───────────────────────────────────────────────────────────
if ($filePath -match '\.js$') {
    $out = & node --check $filePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "SYNTAX ERROR — $rel`:`n$out`nJARVIS: Fix syntax before continuing."
        exit 1
    }
}
elseif ($filePath -match '\.py$') {
    $out = & python -m py_compile $filePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "SYNTAX ERROR — $rel`:`n$out`nJARVIS: Fix syntax before continuing."
        exit 1
    }
}

# ── 3. SECURITY SCAN ──────────────────────────────────────────────────────────
if ($filePath -match '\.(js|py|ts|json)$') {
    $content = try { Get-Content $filePath -Raw } catch { '' }
    if ($content -match 'sk-ant-[A-Za-z0-9\-_]{20,}') {
        Write-Error "SECURITY: Anthropic API key hardcoded in $rel — use env var."
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

# ── 4. RUN TESTS (if server/index.js changed and tests exist) ─────────────────
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
}

# ── 5. COMMIT — specific file only, never git add -A ─────────────────────────
if (git status --porcelain 2>$null) {
    $fileStatus = git status --porcelain $rel 2>$null
    if ($fileStatus) {
        git add $rel 2>$null
        git commit -m "update $rel" --quiet 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "JARVIS: $rel committed — syntax OK, security OK."
        }
    }
}

# ── 6. CODE REVIEW SIGNAL — visible to JARVIS for trading logic changes ────────
$tradingFiles = @(
    'server\index.js',
    'server\autohealer.js',
    'mt5_bridge.py',
    'parallel_analysis.py'
)
foreach ($tf in $tradingFiles) {
    if ($rel -ieq $tf) {
        Write-Host ""
        Write-Host ">>> CODE REVIEW REQUIRED: $rel is a trading logic file." -ForegroundColor Cyan
        Write-Host ">>> JARVIS: invoke the code-reviewer agent on the changed function(s) before declaring done." -ForegroundColor Cyan
        Write-Host ""
        break
    }
}

exit 0
