# PreToolUse AUDIT — appends one line per tool call to tasks/agent_audit.jsonl.
#
# WHY THIS EXISTS. Checked 2026-09-08: there was NO per-tool-call record of what any
# subagent did. The two files that look like one are not:
#
#   tasks/decision_register.jsonl  147 rows, ALL source:"code" — design decisions
#                                  scraped from code comments. Documents intent, not
#                                  behaviour.
#   tasks/ai_decisions.jsonl       42 rows — AI-employee PROPOSALS and their
#                                  dispositions. A verdict ledger, not an action log.
#
# So when an agent "made 6 commits, installed scheduled tasks on the laptop AND the VPS,
# drove the user's browser and rewrote saved TradingView scripts six times, and reversed
# a LOCKED decision" across 217 calls, the only reason that was ever reconstructed was a
# human reading a transcript. Nothing on disk recorded it. Restricting agent `tools:` (in
# .claude/agents/*.md) narrows what CAN happen; this records what DID.
#
# IT REFUSES NOTHING. Not a gate. git-safety.ps1 is the gate and keeps that job — two
# hooks on the same event with two different jobs, so neither becomes the other's excuse.
# This one only ever appends and always exits 0.
#
# IT MUST NOT BREAK A SESSION. Every path is wrapped and the last line is `exit 0`,
# unconditionally. An audit hook that can fail a tool call would be a worse problem than
# the one it solves — and a PreToolUse hook that exits non-zero BLOCKS the call.
#
# SECRETS ARE NOT WRITTEN. Commands and file paths are recorded; a Bash command matching
# a credential pattern is stored with the value masked, because an audit log that quietly
# accumulates API keys is a new liability rather than a control.

try {
    $raw = try { [System.Console]::In.ReadToEnd() } catch { '' }
    if (-not $raw) { exit 0 }
    $j = try { $raw | ConvertFrom-Json } catch { $null }
    if (-not $j) { exit 0 }

    $tool = try { [string]$j.tool_name } catch { '' }
    if (-not $tool) { exit 0 }

    # The identifying detail differs per tool. Keep it short: this file is appended to on
    # EVERY call and an unbounded field would make it unreadable within a day.
    $detail = ''
    try {
        switch -Regex ($tool) {
            '^Bash$'                  { $detail = [string]$j.tool_input.command }
            '^(Edit|Write|Read)$'     { $detail = [string]$j.tool_input.file_path }
            '^(Grep|Glob)$'           { $detail = [string]$j.tool_input.pattern }
            '^Task$'                  { $detail = [string]$j.tool_input.subagent_type }
            default {
                $detail = ($j.tool_input | ConvertTo-Json -Compress -Depth 3)
            }
        }
    } catch { $detail = '' }
    if ($null -eq $detail) { $detail = '' }
    if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + '...(truncated)' }

    # Mask anything that looks like a credential BEFORE it reaches disk.
    $detail = $detail -replace '(sk-ant-[A-Za-z0-9_\-]+)', 'sk-ant-***MASKED***'
    $detail = $detail -replace '(xox[bepas]-[A-Za-z0-9\-]+)', 'xox-***MASKED***'
    $detail = $detail -replace '((?i)(password|token|api[_-]?key)\s*=\s*)\S+', '$1***MASKED***'

    # Computed BEFORE the hash. PowerShell does not accept try/catch as an expression
    # inside a hash literal - it fails with "The hash literal was incomplete", which is a
    # PARSE error, so the hook dies before its own outer catch can run. Caught by feeding
    # the hook a real payload rather than by reading it.
    $agent   = ''
    $session = ''
    $cwd     = ''
    try { $agent   = [string]$j.agent_type } catch { }
    try { $session = [string]$j.session_id } catch { }
    try { $cwd     = [string]$j.cwd }        catch { }

    $row = [ordered]@{
        ts      = (Get-Date).ToUniversalTime().ToString('o')
        tool    = $tool
        detail  = $detail
        # Present when the call comes from a subagent; empty for the main session. This
        # is the field that makes the log answer "which agent did that".
        agent   = $agent
        session = $session
        cwd     = $cwd
    }

    $line = $row | ConvertTo-Json -Compress -Depth 3
    $out  = Join-Path (Get-Item .).FullName 'tasks/agent_audit.jsonl'

    # AppendAllText with UTF8Encoding($false), NOT Add-Content -Encoding utf8.
    # Windows PowerShell 5.1 writes a BOM with -Encoding utf8, and a BOM on line 1 of a
    # .jsonl file makes that row unparseable to any reader that does not trim the whole
    # file first. Node's JSON.parse throws on a leading ﻿; it only survived the test
    # here because .trim() happens to strip it. A reader that walks the file line by line
    # would have lost the first record silently, which is the one failure an audit log
    # must not have.
    #
    # Append-only, and a failure to write is silent BY DESIGN: this hook runs before every
    # tool call, so surfacing an error here would spam the session for something that is
    # not the user's problem mid-task. The absence of rows is itself detectable.
    try {
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($out, $line + [Environment]::NewLine, $enc)
    } catch { }
} catch { }

exit 0
