---
decision_key: d14ebee4336fd64f
source: tasks/fvg_executor.py:441
status: standing
recorded: 2026-09-04T06:15:50.682Z
---

# STANDING DECISION

PIN THE TERMINAL, DO NOT JUST DETECT THE WRONG ONE.

Governs: `terminal_path = os.environ.get("MT5_TERMINAL_PATH", "").strip()`

## The reasoning as recorded

PIN THE TERMINAL, DO NOT JUST DETECT THE WRONG ONE.

A bare initialize() attaches to whichever terminal answers first. On a box running
two - this laptop has the bridge's install on 25446287 and a second in AppData on
11581419, the VPS's account - that is a coin flip, and it landed on the wrong one
every time it was tested. Refusing at that point is safe but leaves the box unable
to trade at all, which is not the goal: each box is meant to trade its OWN account.

mt5_bridge.py:1065 has solved this since 2026-08-01 with MT5_TERMINAL_PATH. Same
mechanism here, same env var, so a box already configured for its bridge needs no
new setting. Unset means the previous behaviour exactly.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
