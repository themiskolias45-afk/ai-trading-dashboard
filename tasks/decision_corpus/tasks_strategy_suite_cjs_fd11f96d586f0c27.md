---
decision_key: fd11f96d586f0c27
source: tasks/strategy_suite.cjs:41
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

no fill could honour. A LOSS IS NEVER CAPPED; this is a ceiling on implausible gain.

Governs: `const { cappedRr } = require(path.join(ROOT, "tasks", "_rr_cap.cjs"));`

## The reasoning as recorded

THE IMPLAUSIBLE-R CAP, which this harness should have used from the start. Measured
2026-09-02: on the CRT+EMA short side, 3 rows of 173 supplied 85% of the total R and
two of them were pinned at whatever cap they were given, while the minimum risk
distance was 0.40 on XAUUSD -- under 2x the 0.22 spread, a stop inside the noise that
no fill could honour. A LOSS IS NEVER CAPPED; this is a ceiling on implausible gain.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
