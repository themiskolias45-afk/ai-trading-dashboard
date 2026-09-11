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

# --- 2. Push last 3 commits to server memory for next session recall ---
# This write failed on EVERY session end for the whole life of the hook, and both
# failures were swallowed by `2>$null | Out-Null`. Found and reproduced 2026-09-01:
#
#   1. HTTP 400. Windows PowerShell 5.1 strips the embedded double quotes when it
#      hands an argument to a native exe, so `curl.exe -d $body` — correct JSON
#      inside PowerShell — arrived as {key:...} and body-parser threw
#      "Expected property name or '}' in JSON at position 1". 66 of those in
#      server_log.txt, all dated 2026-08-31, one per session end.
#      Fixed by writing the body to a file and sending --data-binary "@file".
#
#   2. HTTP 401. /api/memory is deliberately NOT in API_NO_LOGIN_REQUIRED, so even
#      a valid body was rejected — curl carries no session. Fixed by logging in
#      first with the same keys.env credential server/mcp_server.js:122 already
#      uses. The route STAYS gated; the hook acquires a session like every other
#      local process does.
#
# Never blocks and never throws: a missing credential, an offline server or any
# non-200 is recorded in tasks\logs\session_stop.txt and the hook continues.
# Section 4 below is the independent local rail and does not depend on any of this.
$hookLog = Join-Path $proj 'tasks\logs\session_stop.txt'
function Write-HookLog([string]$text) {
    try { Add-Content -Path $hookLog -Value "[$ts] $text" -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
}

$recentLog = git -C $proj log --oneline -3 2>$null
if ($recentLog) {
    $summary   = $recentLog -join " | "
    $memOk     = $false
    $memWhy    = 'not attempted'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $bodyFile  = Join-Path $env:TEMP 'jarvis_session_stop_body.json'
    $loginFile = Join-Path $env:TEMP 'jarvis_session_stop_login.json'
    $cookieJar = Join-Path $env:TEMP 'jarvis_session_stop_cookies.txt'
    try {
        $dashUser = $null
        $dashPass = $null
        $keysPath = Join-Path $proj 'keys.env'
        if (Test-Path $keysPath) {
            foreach ($kv in [System.IO.File]::ReadAllLines($keysPath)) {
                if ($kv -match '^\s*DASHBOARD_USERNAME\s*=\s*(.+?)\s*$') { $dashUser = $Matches[1] }
                if ($kv -match '^\s*DASHBOARD_PASSWORD\s*=\s*(.+?)\s*$') { $dashPass = $Matches[1] }
            }
        }
        if (-not $dashUser -or -not $dashPass) {
            $memWhy = 'DASHBOARD_USERNAME/DASHBOARD_PASSWORD absent from keys.env - the route is gated, so the write is skipped, not forced'
        } else {
            $loginJson = @{ username = $dashUser; password = $dashPass } | ConvertTo-Json -Compress
            [System.IO.File]::WriteAllText($loginFile, $loginJson, $utf8NoBom)
            $loginCode = curl.exe -s -o NUL -w '%{http_code}' -X POST 'http://localhost:3001/api/login' `
                -H 'Content-Type: application/json' --data-binary "@$loginFile" -c $cookieJar --max-time 3 2>$null
            # Emptied, never deleted: the password must not linger in %TEMP%, and the
            # standing rule is that nothing on this system gets deleted.
            [System.IO.File]::WriteAllText($loginFile, '', $utf8NoBom)
            if ("$loginCode" -ne '200') {
                $memWhy = "POST /api/login returned $loginCode"
            } else {
                $bodyJson = @{ key = 'last-session-commits'; value = $summary } | ConvertTo-Json -Compress
                [System.IO.File]::WriteAllText($bodyFile, $bodyJson, $utf8NoBom)
                $memCode = curl.exe -s -o NUL -w '%{http_code}' -X POST 'http://localhost:3001/api/memory' `
                    -H 'Content-Type: application/json' --data-binary "@$bodyFile" -b $cookieJar --max-time 3 2>$null
                if ("$memCode" -eq '200') { $memOk = $true; $memWhy = 'ok' }
                else { $memWhy = "POST /api/memory returned $memCode" }
            }
            # Same treatment as the login body — the jar holds the live session secret.
            [System.IO.File]::WriteAllText($cookieJar, '', $utf8NoBom)
        }
    } catch {
        $memWhy = "exception: $($_.Exception.Message)"
    }
    if ($memOk) {
        Write-HookLog "last-session-commits written: $summary"
    } else {
        Write-HookLog "last-session-commits NOT written - $memWhy"
        Write-Host "session-stop: last-session-commits not persisted ($memWhy). tasks\jarvis-state.json still carries them." -ForegroundColor DarkYellow
    }
}

# --- 3. Check for uncommitted changes — warn so nothing is lost ---
$dirty = git -C $proj status --porcelain 2>$null
if ($dirty) {
    $count = ($dirty | Measure-Object -Line).Lines
    Write-Host ""
    Write-Host "WARNING: $count uncommitted file(s) when session ended. Run: git add [files] && git commit" -ForegroundColor Red
}

# --- 4. Write structured state snapshot to tasks/jarvis-state.json ---
# A lightweight snapshot so the next session can reconstruct context even if
# the vault note and MCP memory are both offline. /learn writes the richer
# last-session-state; this only records git facts that the hook knows.
$stateFile = Join-Path $proj 'tasks\jarvis-state.json'
try {
    $lastCommits = @(git -C $proj log --oneline -5 2>$null)
    $dirtyList   = @(if ($dirty) { $dirty | Select-Object -First 10 | ForEach-Object { $_.ToString().Trim() } })
    $stateSnap   = [ordered]@{
        saved        = (Get-Date -Format 'o')
        source       = 'session-stop hook'
        commits      = $lastCommits
        dirty_files  = $dirtyList
        note         = 'Run /state load or /learn recall to restore session context'
    }
    $stateJson = $stateSnap | ConvertTo-Json -Depth 3
    [System.IO.File]::WriteAllText($stateFile, $stateJson, (New-Object System.Text.UTF8Encoding($false)))
} catch {
    # Write failure must never crash the hook — state file is a convenience, not a blocker.
}

# --- 5. Make any memory written this session FINDABLE ---
#
# WHY HERE. The memory corpus is reindexed once a day by tasks/brain_sync.cjs (04:10), so
# a memory written at 18:00 was not retrievable for ten hours. Measured 2026-09-11: four
# memories were missing from the index, every one written after that morning's run.
# CLAUDE.md says "Rebuild after writing a memory: python tasks/rag_index.py --source
# brain" — a rule enforced by remembering, which this repo's own doctrine calls
# decoration. This is its enforcer, at the moment the memory was actually written.
#
# NOTHING CAN BE LOST BY IT. The guard runs INCREMENTAL only and never --rebuild (that
# deletes the collection before re-adding, and a run killed in that window left the index
# EMPTY on 2026-09-01 while reporting a healthy-looking count). It reads chunk counts
# before and after and shouts if the index SHRANK, which incremental indexing cannot
# cause. And the .md files are the memory — this index is derived from them and can be
# rebuilt at any time, so an index failure is never a memory loss.
#
# IT CANNOT HANG THE SESSION. It exits in ~0.3s when no memory changed. When there IS
# work it needs ~35s to load the embedding model, so this waits a bounded 90s and then
# lets it finish DETACHED rather than killing it — an interrupted incremental add is
# harmless, but so is letting it complete, and its own log records the outcome either way.
try {
    $guard = Join-Path $proj 'tasks\memory_index_guard.py'
    if (Test-Path $guard) {
        $py = $env:SMARTENTRY_PYTHON
        if (-not $py -or -not (Test-Path $py)) { $py = (Get-Command python -ErrorAction SilentlyContinue).Source }
        if ($py) {
            # -NoNewWindow ONLY. Passing -WindowStyle alongside it throws
            # InvalidOperationException - they are mutually exclusive - and the catch
            # below then swallowed it, so the hook "passed" in 2.17s having indexed
            # NOTHING. Caught 2026-09-11 only because the run was timed.
            $p = Start-Process -FilePath $py -ArgumentList @($guard) `
                    -WorkingDirectory $proj -PassThru -NoNewWindow
            if (-not $p.WaitForExit(90000)) {
                Write-Host "memory index still running - left to finish in the background (tasks/logs/memory_index.txt)" -ForegroundColor DarkGray
            }
        } else {
            Write-MemIndexNote "no python on PATH and SMARTENTRY_PYTHON unset - memory not indexed this session"
        }
    }
} catch {
    # NAMED, NOT SWALLOWED. A memory that is slow to become searchable must never fail a
    # session - but a guard that fails silently is how this one indexed nothing for a
    # whole run and still printed success.
    Write-MemIndexNote ("memory index could not start: " + $_.Exception.Message)
}
