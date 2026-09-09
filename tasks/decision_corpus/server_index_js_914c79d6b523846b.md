---
decision_key: 914c79d6b523846b
source: server/index.js:5774
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

M15 WAS STORED AND NEVER REPORTED. sanitizeBars caches it a few lines above and

Governs: `m15: mt5CandleCache[assetKey].bars.m15?.closes.length ?? 0,`

## The reasoning as recorded

M15 WAS STORED AND NEVER REPORTED. sanitizeBars caches it a few lines above and
generateSignalMTF consumes it - BTC M15 was producing a live M15_MOMENTUM SELL
while this response said 3 timeframes. The bridge logs "4tf" and the server
answered "d1/h4/h1", so the only visible evidence said M15 was not arriving.
A feed that works but reports nothing is indistinguishable from one that is dead.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
