---
decision_key: 4f4ed600c118fb2a
source: server/evidence_register.js:450
status: standing
recorded: 2026-09-08T03:37:10.852Z
---

# STANDING DECISION

THE SAMPLE THIS CLAIM NEVER DECLARED, which is why it could not flag itself.

Governs: `sampleAtWriting: { maxSetupClosedTrades: 5 },`

## The reasoning as recorded

THE SAMPLE THIS CLAIM NEVER DECLARED, which is why it could not flag itself.

3 is not a guess: the evidence text above states "MOMENTUM is 2W-1L" and every
other tracked setup sat at 1 closed trade, so 3 was the largest per-setup total
on measuredOn 2026-08-30. Live is now 5, and crossing LEARNING_MIN_TRADES is
exactly the event changesTheAnswer said had not happened yet - so recurationCheck
will now raise this claim as needing recuration instead of letting the prose go
on describing a hypothetical that has already occurred.
Re-curated to the LIVE figure on 2026-09-07 rather than left flagging: the prose
above now describes the crossing instead of denying it, so pinning this at 3 would
keep raising a drift that has been dealt with. It stays declared, so the NEXT move
raises it again - which is the whole point of the field.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
