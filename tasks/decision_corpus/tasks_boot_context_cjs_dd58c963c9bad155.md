---
decision_key: dd58c963c9bad155
source: tasks/boot_context.cjs:240
status: standing
recorded: 2026-09-02T18:27:20.096Z
---

# STANDING DECISION

NEVER fatal. A context helper that breaks a session start is worse than one that

Governs: `if (!QUIET) console.error("[boot-context] skipped: " + e.message);`

## The reasoning as recorded

NEVER fatal. A context helper that breaks a session start is worse than one that
says nothing, and this runs before anything has been checked.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
