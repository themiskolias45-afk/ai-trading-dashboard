---
decision_key: 09e2df8d72f91a1a
source: server/index.js:7789
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

branch has NEVER executed and the bucket is empty rather than contaminated.

Governs: `h1Agree:        sig.h1Agree ?? null,`

## The reasoning as recorded

h1Agree HERE IS WEAKER EVIDENCE THAN ON THE BRIDGE BRANCH, and the split must
treat it that way. The guard above is `sig.signal === trade.type` - DIRECTION
only. h1Agree is derived from h1.trend AND signalDir (:3851), so corroborating
the direction constrains one of its two inputs and says nothing about the other:
if H1 flips between the decision and this POST while the direction still reads
BUY, h1Agree flips AGREE->AGAINST and the corroboration still passes. It is
recorded because a labelled gap beats no gap, not because it is trustworthy.

NULL IS OVERLOADED AND CANNOT BE DISAMBIGUATED FROM THE ROW ALONE. null is both
"this bridge predates the field" and the producer's own legitimate output when
signalDir is WAIT or h1.trend is missing. Nothing records bridge version.

SO THE SPLIT MUST FILTER ON setupSource === "bridge" - which persists as a
top-level journal column - and must NOT pool this branch in. Measured
2026-09-07: setupSource is {bridge: 7, undefined: 3} across 10 rows, so this
branch has NEVER executed and the bucket is empty rather than contaminated.
It also means the fill rate depends on mt5_bridge.py reaching BOTH boxes; with
only one deployed the other keeps writing indistinguishable nulls.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
