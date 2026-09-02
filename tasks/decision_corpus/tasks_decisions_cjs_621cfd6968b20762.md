---
decision_key: 621cfd6968b20762
source: tasks/decisions.cjs:262
status: standing
recorded: 2026-09-02T18:12:00.722Z
---

# STANDING DECISION

NEVER BLOCKS, always exit 0. A guard that can stop an edit becomes a thing to work

Governs: `function cmdGuard(target) {`

## The reasoning as recorded

THE GUARD: given a file about to be edited, print the standing decisions IT carries.

This is the automatic half, and it is the half that matters. `check` requires someone to
remember to ask, and on 2026-09-02 nobody did -- an agent edited tradingview_bot.py, which
carries a locked decision at line 1185, and reversed it. The file was known. The decision
was known. Nothing put them in front of each other.

NEVER BLOCKS, always exit 0. A guard that can stop an edit becomes a thing to work
around; a guard that just says "this file carries a decision, here it is" is read.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
