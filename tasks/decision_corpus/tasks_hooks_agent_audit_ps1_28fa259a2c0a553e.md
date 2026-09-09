---
decision_key: 28fa259a2c0a553e
source: tasks/hooks/agent-audit.ps1:1
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

a LOCKED decision" across 217 calls, the only reason that was ever reconstructed was a

Governs: `try {`

## The reasoning as recorded

PreToolUse AUDIT — appends one line per tool call to tasks/agent_audit.jsonl.

WHY THIS EXISTS. Checked 2026-09-08: there was NO per-tool-call record of what any
subagent did. The two files that look like one are not:

  tasks/decision_register.jsonl  147 rows, ALL source:"code" — design decisions
                                 scraped from code comments. Documents intent, not
                                 behaviour.
  tasks/ai_decisions.jsonl       42 rows — AI-employee PROPOSALS and their
                                 dispositions. A verdict ledger, not an action log.

So when an agent "made 6 commits, installed scheduled tasks on the laptop AND the VPS,
drove the user's browser and rewrote saved TradingView scripts six times, and reversed
a LOCKED decision" across 217 calls, the only reason that was ever reconstructed was a
human reading a transcript. Nothing on disk recorded it. Restricting agent `tools:` (in
.claude/agents/*.md) narrows what CAN happen; this records what DID.

IT REFUSES NOTHING. Not a gate. git-safety.ps1 is the gate and keeps that job — two
hooks on the same event with two different jobs, so neither becomes the other's excuse.
This one only ever appends and always exits 0.

IT MUST NOT BREAK A SESSION. Every path is wrapped and the last line is `exit 0`,
unconditionally. An audit hook that can fail a tool call would be a worse problem than
the one it solves — and a PreToolUse hook that exits non-zero BLOCKS the call.

SECRETS ARE NOT WRITTEN. Commands and file paths are recorded; a Bash command matching
a credential pattern is stored with the value masked, because an audit log that quietly
accumulates API keys is a new liability rather than a control.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
