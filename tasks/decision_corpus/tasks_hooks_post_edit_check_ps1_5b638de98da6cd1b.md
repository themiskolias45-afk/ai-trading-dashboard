---
decision_key: 5b638de98da6cd1b
source: tasks/hooks/post-edit-check.ps1:144
status: standing
recorded: 2026-09-05T06:30:27.886Z
---

# STANDING DECISION

Trading-logic files are NEVER auto-committed: code review must pass first.

Governs: `if (-not $isTrading) {`

## The reasoning as recorded

-- 5. COMMIT -- specific file only, never git add -A -------------------------
Trading-logic files are NEVER auto-committed: code review must pass first.
$tradingFiles / $isTrading are set in section 3b above.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
