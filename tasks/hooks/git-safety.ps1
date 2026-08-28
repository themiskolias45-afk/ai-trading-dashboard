# PreToolUse DENY GATE for destructive commands -- runs before every Bash call.
# NOT async: an async PreToolUse hook is fire-and-forget, so its verdict is never
# honoured. This one must be able to REFUSE, which means the harness has to wait.
#
# WHY THIS WAS REWRITTEN (2026-08-24)
# The file kept its name; what it did was rewritten, because the version here could
# not enforce the rule it existed for. "No deleting -- ever, without explicit
# approval" is the standing rule the user has restated more than any other, and
# /api/ai-registry listed it as PROCEDURAL -- i.e. nothing enforced it. Three
# separate defects, each verified by reading the file:
#
#   1. It ended in `exit 0` UNCONDITIONALLY. It took a backup and then let every
#      destructive command through. It was registered "async": true as well, so the
#      harness never waited for it either way. A safety switch that cannot switch.
#   2. Its pattern was `git\s+(reset --hard|clean -[fdx]|checkout --|restore \.)`.
#      `git stash` was NOT in it -- and tasks/../never_git_stash_in_this_repo is on
#      record precisely because a stash reverted learning.json off a locked WAL.
#      `rm`, `Remove-Item` and `del` were not covered AT ALL: the pattern only ever
#      matched commands beginning with `git`, so `rm server/learning.json` passed
#      straight through.
#   3. Its backup copied `dashboard/` and `server/index.js` -- and nothing else.
#      Not learning.json, not journal.json, not smartentry.db, not jarvis_memory,
#      not the rejection ledger, not the bar cache. None of the data the rule
#      exists to protect.
#
# WHAT IT DOES NOW
# Blocks rather than backs up. Blocking is strictly safer than copying-then-
# destroying: if the command never runs, there is nothing to restore. It refuses
# only when a destructive command meets a PROTECTED path, or when the command is
# repo-wide and therefore endangers all of them at once.
#
# IT MUST STAY QUIET DURING ORDINARY WORK. A hook that fires on every `rm` of a
# temp file gets switched off, and a disabled guard is worse than none -- the same
# reasoning as an action item that can never clear. Scratch paths are allow-listed.
#
# DELIBERATE OVERRIDE
#   $env:JARVIS_ALLOW_DESTRUCTIVE = '1'
# That is the "explicit approval" half of the rule, made explicit. It is per-shell
# and never set by default.

param()

$raw = try { [System.Console]::In.ReadToEnd() } catch { '' }
$j   = try { $raw | ConvertFrom-Json } catch { $null }
if (-not $j) { exit 0 }           # unparseable stdin: same fail-open as the sibling hooks

$cmd = try { [string]$j.tool_input.command } catch { '' }
if ([string]::IsNullOrWhiteSpace($cmd)) { exit 0 }

if ($env:JARVIS_ALLOW_DESTRUCTIVE -eq '1') {
    Write-Host "JARVIS: destructive guard OVERRIDDEN by JARVIS_ALLOW_DESTRUCTIVE=1."
    exit 0
}

# ── The data the rule exists to protect ───────────────────────────────────────
# Weeks of real trades and the learning that came off them. Every one of these is
# either irreplaceable or expensive to rebuild.
$protectedPatterns = @(
    'server[\\/]learning\.json',
    'server[\\/]journal\.json',
    'server[\\/]smartentry\.db',          # also catches -shm / -wal
    'server[\\/]hermes_state\.json',
    'server[\\/]evidence_register\.js',
    'server[\\/]strategy_settings\.json',
    'tasks[\\/]jarvis_memory\.json',
    'tasks[\\/]rejections.*\.jsonl',
    'tasks[\\/]score.*\.jsonl',
    'tasks[\\/]strategy_search_ledger\.jsonl',
    # \b rather than [\\/] on the directory entries. Requiring a trailing separator
    # meant `rm -rf tasks/history/` matched but `rm -rf tasks/history` did NOT — the
    # commoner form, and the more destructive one. Caught by the test table in
    # tasks/hooks/test-git-safety.ps1, which is the reason that table exists.
    'tasks[\\/]history\b',                # the bar cache — 29 days to rebuild, and only on a flat book
    'tasks[\\/]daily\b',
    'tasks[\\/]analysis\b',
    'tasks[\\/]backups\b',
    'tasks[\\/]logs\b'
)

# Paths that are ALWAYS safe to delete. Ordinary work must not trip this gate.
$scratchPatterns = @(
    'AppData[\\/]Local[\\/]Temp',
    '[\\/]scratchpad[\\/]',
    '_probe',
    '\.tmp\b',
    'node_modules'
)

# ── Destructive intent ────────────────────────────────────────────────────────
# Repo-wide: endangers every tracked protected file at once, so the target does not
# have to be named for this to be dangerous.
$repoWide = @(
    'git\s+stash',                     # THE one that already cost learning.json
    'git\s+reset\s+--hard',
    'git\s+clean\s+-[a-z]*[fdx]',
    'git\s+checkout\s+(-f|--force|--\s)',
    'git\s+restore\s+\.',
    'git\s+push\s+.*--force(?!-with-lease)'
)

# Path-targeted deletion: dangerous only when it names something protected.
$pathTargeted = @(
    '\brm\s+(-[a-zA-Z]*\s+)*',
    'Remove-Item\b',
    '\bdel\s+',
    '\brmdir\b',
    'Clear-Content\b'
)

function Test-Any([string]$text, [string[]]$patterns) {
    foreach ($p in $patterns) { if ($text -match $p) { return $true } }
    return $false
}

function Deny([string]$why, [string]$detail) {
    # exit 2 = refuse the tool call; stderr is what Claude is shown.
    Write-Error @"
JARVIS DESTRUCTIVE-COMMAND BLOCK

  $why
  $detail

  Nothing was run. This is the standing rule "never delete without explicit
  approval", enforced rather than remembered.

  If this is genuinely intended: say so explicitly, take a verified timestamped
  backup FIRST, then re-run in a shell with JARVIS_ALLOW_DESTRUCTIVE=1.
  Prefer moving or renaming over deleting -- that is reversible and this gate
  does not stand in its way.
"@
    exit 2
}

# 0. Secret file staging: block `git add` on credential files before they reach a commit.
#    These files must NEVER enter the index. The post-edit hook already blocks writing
#    them, but a manual `git add` in a shell bypasses that hook entirely.
$secretFilePatterns = @(
    'server[\\/]apikey\.txt',
    '(?<![.\w])keys\.env(\b|$|\.)',
    '(?<![.\w])\.env(\b|$|\.)'
)
if ($cmd -match '\bgit\s+add\b') {
    foreach ($sf in $secretFilePatterns) {
        if ($cmd -match $sf) {
            Deny "Attempt to stage a secrets file." `
                 "Pattern matched: $sf`n  These files must NEVER be committed. Stage specific non-secret files instead."
        }
    }
}

# 1. Repo-wide destructive git operations. Always refused: they can revert or drop
#    learning.json, the journal and the SQLite WAL together, which is the exact
#    accident already on record for `git stash` in this repo.
if (Test-Any $cmd $repoWide) {
    $matched = ($repoWide | Where-Object { $cmd -match $_ }) -join ', '
    Deny "Repo-wide destructive git command detected." `
         "Pattern: $matched`n  This can revert or drop server/learning.json, server/journal.json and smartentry.db-wal together."
    # (unreachable — Deny exits)
}

# 2. Deletion aimed at a protected path.
if (Test-Any $cmd $pathTargeted) {
    if (-not (Test-Any $cmd $scratchPatterns)) {
        $hits = @($protectedPatterns | Where-Object { $cmd -match $_ })
        if ($hits.Count -gt 0) {
            Deny "Deletion aimed at protected trading or learning data." `
                 "Matched protected path(s): $($hits -join ', ')"
        }
    }
}

# 3. Truncating redirect onto a protected file ( > file ). Overwrites in place and
#    loses the previous contents just as completely as a delete, which is why the
#    standing rule says copy before you rewrite.
#    The lookbehind excludes BOTH a digit (so `2>&1` and `2>$null` are not redirects
#    of interest) and a `>` -- without the latter, the SECOND angle bracket of `>>`
#    matches and every append would be flagged as a truncation.
if ($cmd -match '(?<![>\d])>(?!>)\s*("?[^"|;&\s]+"?)') {
    $target = $Matches[1].Trim('"')
    if (-not (Test-Any $target $scratchPatterns)) {
        $hits = @($protectedPatterns | Where-Object { $target -match $_ })
        if ($hits.Count -gt 0) {
            Deny "Truncating redirect onto protected data." `
                 "Target: $target`n  '>' replaces the file. Use '>>' to append, or write a timestamped copy first."
        }
    }
}

exit 0
