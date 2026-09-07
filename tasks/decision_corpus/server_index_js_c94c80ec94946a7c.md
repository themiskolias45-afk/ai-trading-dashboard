---
decision_key: c94c80ec94946a7c
source: server/index.js:8317
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

NEVER merged into newsCache, which is what isNewsBlackout() reads, so nothing here

Governs: `projection: (() => {`

## The reasoning as recorded

PROJECTED releases, so a plan can see past the end of the weekly feed - 90-odd days
instead of the 0.8 the feed reaches today. Separate array on purpose: these are
NEVER merged into newsCache, which is what isNewsBlackout() reads, so nothing here
can gate an entry, move a threshold or suppress a setup. A guess that blocks
trading costs money silently; a guess that only informs a plan costs nothing when
it is wrong. Each row carries projected:true and its own confirmed/contradicted
status against what has actually been observed.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
