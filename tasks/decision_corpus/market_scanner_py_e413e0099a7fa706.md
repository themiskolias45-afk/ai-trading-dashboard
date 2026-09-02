---
decision_key: e413e0099a7fa706
source: market_scanner.py:96
status: standing
recorded: 2026-09-02T17:54:29.703Z
---

# STANDING DECISION

/api/learning returns setupStats, NEVER "setups" — verified 2026-08-24, its top

Governs: `setups    = (learning.get("setupStats") or learning.get("setups") or {}) if isinstance(learning, dict) else {}`

## The reasoning as recorded

Win rate from learning data.
/api/learning returns setupStats, NEVER "setups" — verified 2026-08-24, its top
keys are setupStats, sessionCount, updatedAt, shadow, unattributed,
reconciliation. So this read the missing key, got {}, and every row has shown
"WR -" since it was written, with the win-rate term of the score silently
pinned to zero. tv_daily_plan.py already had the fallback; this did not.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
