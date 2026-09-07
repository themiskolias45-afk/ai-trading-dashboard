---
decision_key: 2db50eac8ad797b9
source: server/index.js:1985
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

passes six arguments and barSource defaults to null. Those rows can NEVER be walked

Governs: `const ledgerEnabled = barSource?.replay !== true;`

## The reasoning as recorded

REPLAY MODE — do not write to the rejection ledger or the gate counters.

This function is called two ways. LIVE, once per refresh, on the current bars: those
gate decisions are real, and every rejection is a fully priced paper trade the whole
rejection-evidence system depends on. And by runBacktest (:8553), which walks five
YEARS of history one bar at a time and calls this on every step.

Until 2026-09-02 both wrote to the same ledger. Measured that day: 1,536 of 3,344 rows
— 45.9% — carried dataSource, sourceSymbol and timeframe all null, because runBacktest
passes six arguments and barSource defaults to null. Those rows can NEVER be walked
forward: nothing records which instrument the levels were priced on. MIN_RR alone held
109 unscorable episodes against 189 total, and 182 rows landed in a single minute —
the fingerprint of a replay loop, not of live trading.

The ledger therefore looked healthy at 3,344 rows while nearly half of it could never
become evidence. That matters more than it sounds: sample size is the binding
constraint on this system, and this is the one mechanism that manufactures evidence at
zero risk. Half of it was being thrown away.

The counters are suppressed too, not just the ledger writes. Suppressing kills while
still counting passes would skew every ratio on /api/gate-health in the opposite
direction — a fix that creates a subtler version of the same lie.

A CONST, evaluated once, and NOT a free variable: generateSignal is extracted
TEXTUALLY into a bare vm sandbox by tasks/_replay_mtf.cjs and tasks/_replay_engine.cjs,
where an undefined binding is a ReferenceError the harness catch swallows, silently
deleting the whole cohort from the measurement. That has already happened twice here.
Declared inside the function, it travels with the extracted text.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
