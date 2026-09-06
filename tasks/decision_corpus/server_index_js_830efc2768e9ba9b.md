---
decision_key: 830efc2768e9ba9b
source: server/index.js:12477
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

-- /api/lab-queue -- ask for a backtest; NEVER run one here ---------------

Governs: `const LAB_QUEUE_MAX_PENDING = 500;`

## The reasoning as recorded

-- /api/lab-queue -- ask for a backtest; NEVER run one here ---------------
THE SERVER DOES NOT RUN BACKTESTS. It validates a spec and appends it to a queue;
tasks/lab_queue.cjs --drain does the work out of band. That boundary is structural
rather than a matter of judgement, because this is the box that trades and "it is
only 0.3 seconds" stops being true the moment somebody adds a slower strategy.

Session-gated by omission, like every /api path not on an allowlist. The POST is a
WRITE, so it is gated in the strongest sense available here.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
