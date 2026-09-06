---
decision_key: f7f1a5af035cf929
source: tasks/memory_lint.cjs:58
status: standing
recorded: 2026-09-03T06:00:38.175Z
---

# STANDING DECISION

DISCOVERED, NEVER HARDCODED — and the first version of this function hardcoded it.

Governs: `function memoryDir() {`

## The reasoning as recorded

DISCOVERED, NEVER HARDCODED — and the first version of this function hardcoded it.

The slug is derived from the repo's own location, so the two boxes disagree on it:
the laptop is ~/.claude/projects/C--Users-User-ai-trading-dashboard/memory and the VPS
is ~/.claude/projects/C--ai-trading-dashboard/memory. Hardcoding the laptop's slug made
this report "memory dir not found on this box — nothing to lint" on a VPS that holds
317 memories. A checker that finds nothing for a plausible-sounding reason is the exact
failure this file was written to catch, committed by this file on its first day.

tasks/rag_index.py's _find_brain_corpus() already solved this and its comment says so
outright. I wrote a second copy of the same lookup and got it wrong instead of reading
the one next door, which is the duplicate-check rule failing at my own hands.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
