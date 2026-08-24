# Test table for tasks/hooks/git-safety.ps1 — the destructive-command deny gate.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tasks\hooks\test-git-safety.ps1
#
# WHY A TABLE AND NOT A GLANCE
# This gate has two ways to be wrong and they are not symmetric. A false NEGATIVE
# loses trade data. A false POSITIVE is arguably worse in practice: a hook that
# fires during ordinary work gets switched off, and a disabled guard protects
# nothing at all. So the PASS cases below matter as much as the BLOCK cases, and
# both halves must be re-run after any edit to the patterns.
#
# It has already earned its keep once: `rm -rf tasks/history` passed, because the
# protected pattern required a trailing separator and the commoner, more
# destructive form of the command does not have one.
#
# Reads nothing, writes nothing, runs no git command. It only pipes JSON at the
# hook and reads the exit code — 2 means refused, anything else means allowed.

$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $root
$hook = Join-Path $PSScriptRoot 'git-safety.ps1'
if (-not (Test-Path $hook)) { Write-Error "hook not found: $hook"; exit 1 }

$cases = @(
    # ── must REFUSE: repo-wide git operations ────────────────────────────────
    @{ x = 'BLOCK'; c = 'git stash' }
    @{ x = 'BLOCK'; c = 'git stash push -m wip' }
    @{ x = 'BLOCK'; c = 'git reset --hard origin/main' }
    @{ x = 'BLOCK'; c = 'git clean -fdx' }
    @{ x = 'BLOCK'; c = 'git checkout -f' }
    @{ x = 'BLOCK'; c = 'git restore .' }
    @{ x = 'BLOCK'; c = 'git push origin main --force' }

    # ── must REFUSE: deletion aimed at protected data ────────────────────────
    @{ x = 'BLOCK'; c = 'rm server/learning.json' }
    @{ x = 'BLOCK'; c = 'rm -rf tasks/history' }
    @{ x = 'BLOCK'; c = 'rm -rf tasks/history/' }
    @{ x = 'BLOCK'; c = 'rm -f server/journal.json' }
    @{ x = 'BLOCK'; c = 'Remove-Item server\smartentry.db -Force' }
    @{ x = 'BLOCK'; c = 'Remove-Item tasks\jarvis_memory.json' }
    @{ x = 'BLOCK'; c = 'del tasks\rejections.jsonl' }
    @{ x = 'BLOCK'; c = 'rm tasks/strategy_search_ledger.jsonl' }

    # ── must REFUSE: truncating redirect over protected data ─────────────────
    @{ x = 'BLOCK'; c = 'echo x > server/learning.json' }
    @{ x = 'BLOCK'; c = 'node gen.js > tasks/jarvis_memory.json' }

    # ── must ALLOW: ordinary work. A gate that trips here gets disabled. ──────
    @{ x = 'PASS';  c = 'git status --porcelain' }
    @{ x = 'PASS';  c = 'git add tasks/foo.js; git commit -m x' }
    @{ x = 'PASS';  c = 'git push origin claude/backup-deploy-server-FWgpv' }
    @{ x = 'PASS';  c = 'git push --force-with-lease origin feature' }
    @{ x = 'PASS';  c = 'git checkout -b newbranch' }
    @{ x = 'PASS';  c = 'cat server/learning.json' }
    @{ x = 'PASS';  c = 'node --check server/index.js 2>&1' }
    @{ x = 'PASS';  c = 'node tasks/topup_bars_from_bridge.cjs --execute' }
    @{ x = 'PASS';  c = 'echo hi >> tasks/logs/x.txt' }
    @{ x = 'PASS';  c = 'curl -s http://localhost:3001/api/signals > /tmp/out.json' }
    @{ x = 'PASS';  c = 'rm -f "C:/Users/User/AppData/Local/Temp/claude/abc/scratchpad/raw.json"' }
    @{ x = 'PASS';  c = 'Remove-Item tasks/_verify_probe.cjs -Force' }
    @{ x = 'PASS';  c = 'rm -rf server/node_modules/.cache' }
    @{ x = 'PASS';  c = 'rm dashboard/screenshots/btc.png' }
)

$fail = 0
foreach ($t in $cases) {
    $payload = @{ tool_input = @{ command = $t.c } } | ConvertTo-Json -Compress
    $payload | & powershell -NoProfile -NonInteractive -File $hook 2>$null | Out-Null
    $got = if ($LASTEXITCODE -eq 2) { 'BLOCK' } else { 'PASS' }
    $ok  = ($got -eq $t.x)
    if (-not $ok) { $fail++ }
    "{0}  want={1,-5} got={2,-5}  {3}" -f $(if ($ok) { '  ok' } else { 'FAIL' }), $t.x, $got, $t.c
}

""
if ($fail -eq 0) {
    "ALL $($cases.Count) CASES CORRECT"
    exit 0
} else {
    "*** $fail of $($cases.Count) FAILED ***"
    exit 1
}
