---
decision_key: c6fad646bc144869
source: tasks/config_drift.cjs:155
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

NEVER fall back to a guessed value here - the whole point is to compare against

Governs: `return { cfg: null, source: null, error: e.message };`

## The reasoning as recorded

NEVER fall back to a guessed value here - the whole point is to compare against
what is really running. No settings means no verdict.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
