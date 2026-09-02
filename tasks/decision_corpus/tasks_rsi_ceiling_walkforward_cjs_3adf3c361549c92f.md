---
decision_key: 3adf3c361549c92f
source: tasks/rsi_ceiling_walkforward.cjs:87
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

THE BASELINE IS READ FROM THE LIVE CONFIG, NEVER HARDCODED.

Governs: `function readLiveCeiling() {`

## The reasoning as recorded

THE BASELINE IS READ FROM THE LIVE CONFIG, NEVER HARDCODED.

It used to be `72/68, baseline: true` in the table above. The ceiling MOVED to 80/76
on 2026-08-26 and this file did not, so on 2026-08-27 it still printed
"72/68  BASELINE - what ships today" and computed EVERY CHALLENGER/REJECTED verdict
against a ceiling that had stopped shipping a day earlier. The BTC run called 88/84
"REJECTED - does not beat the baseline's worst fold" against 72/68 (-0.459), when
against what was in force at the time, 80/76 (-0.550), it is EQUAL and carries +8.4R
more. The verdict column was wrong in the direction that matters.

"actually in force" is now WRONG here too: the ceiling moved again, to 88/84 on
2026-08-28, and this sentence described 80/76 as current. Caught by
tasks/config_drift.cjs on the same day it was taught to read this kind of claim —
the tool finding a stale number inside the very comment about stale numbers. Phrased
as history now, which is what it is; the harness itself reads the live values from
strategy_settings.json and was never affected.

That is the same failure this project keeps having in new places - a number copied
out of the config and left behind when the config moved. A harness that judges a
setting must READ that setting.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
