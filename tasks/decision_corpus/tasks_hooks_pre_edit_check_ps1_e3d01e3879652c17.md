---
decision_key: e3d01e3879652c17
source: tasks/hooks/pre-edit-check.ps1:32
status: standing
recorded: 2026-09-02T17:54:29.703Z
---

# STANDING DECISION

-- DUPLICATE GUARD -- warn when this already exists. NEVER blocks (exit stays 0).

Governs: `try {`

## The reasoning as recorded

-- DUPLICATE GUARD -- warn when this already exists. NEVER blocks (exit stays 0).

"duplicate" appears in 67 commit messages here. 0f943e1: "I built a duplicate
stop-variant scorer -- tasks/score_stop_variants.cjs already existed". CLAUDE.md has
said "Always check what exists first" the whole time and it does not fire, because a
rule enforced by remembering is enforced by nothing -- exactly what fb8b4f9 found
about the mojibake check. This runs whether or not anyone remembers.

The logic is in tasks/duplicate_check.cjs, not here, because that is testable:
  node tasks/duplicate_check.cjs --selftest
It regression-tests both real historical mistakes.

Input goes through a temp FILE, never an argument. Embedded quotes in an argument
get mangled by PowerShell -- the same bug that put 66 HTTP 400s in the session-stop
hook until it switched to --data-binary "@file". Fixed path, overwritten each run,
never deleted.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
