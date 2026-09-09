---
decision_key: 47f6d3b10bd71b76
source: mt5_bridge.py:3332
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

line — record_closed_outcome() — never ran: THE CIRCUIT BREAKER NEVER

Governs: `reconciled_pnl, _, reconciled_close_time, _ = outcome`

## The reasoning as recorded

FOUR values, not three. summarize_closed_position returns
(pnl, close_price, close_time, close_time_broker) — the two other call
sites unpack all four (lines 3094 and 3257). This one took three and
raised ValueError every time a close was actually recovered.

IT FAILED SILENTLY AND IN THE WORST PLACE. Every caller of
reconcile_open_trades() wraps it in `except Exception` (1238, 3396), so the
ValueError was swallowed as a generic reconciliation failure. And it throws
AFTER report_reconciled_close() has already succeeded, so the very next
line — record_closed_outcome() — never ran: THE CIRCUIT BREAKER NEVER
COUNTED A CLOSE RECOVERED FROM AN OUTAGE. The breaker under-counted exactly
when the bridge had been offline, which is when losses are most likely to
have accumulated unseen.

Found 2026-09-08 by the `tester` agent on its first run through
run_agent.bat, and verified here against both working call sites before
being applied.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
