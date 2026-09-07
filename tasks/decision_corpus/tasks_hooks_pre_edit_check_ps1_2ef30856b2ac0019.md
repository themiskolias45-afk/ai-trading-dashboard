---
decision_key: 2ef30856b2ac0019
source: tasks/hooks/pre-edit-check.ps1:60
status: standing
recorded: 2026-09-02T18:12:00.722Z
---

# STANDING DECISION

-- DECISION GUARD -- this file carries a standing decision. NEVER blocks (exit stays 0).

Governs: `try {`

## The reasoning as recorded

-- DECISION GUARD -- this file carries a standing decision. NEVER blocks (exit stays 0).

Added 2026-09-02, the day it was needed and absent. An agent edited tradingview_bot.py
and reversed a LOCKED decision recorded at line 1185 of that same file, after a real
2026-08-24 incident. Nothing was hidden: the file was known, the decision was known, and
nothing put them in front of each other. Measured the same day, 38 standing decisions
live inside source comments across the tree, and tasks/rag_index.py indexes trades,
shadow, memory, brain and vault -- not source. "Has this already been decided?" was an
unanswerable question unless you already knew the filename.

Same reasoning as the duplicate guard above: CLAUDE.md has said "locked decisions stay
locked" the whole time and it does not fire, because a rule enforced by remembering is
enforced by nothing. This runs whether or not anyone remembers.

The logic is in tasks/decisions.cjs, not here, so it stays testable:
  node tasks/decisions.cjs guard <file>     what this hook prints
  node tasks/decisions.cjs check "<topic>"  the same question, by topic

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
