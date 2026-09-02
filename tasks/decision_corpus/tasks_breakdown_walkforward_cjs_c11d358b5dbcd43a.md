---
decision_key: c11d358b5dbcd43a
source: tasks/breakdown_walkforward.cjs:304
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

read a partial run as a clean one. A DO NOT SHIP is exit 0 — that is a successful

Governs: `if (failedAssets.length) process.exitCode = 3;`

## The reasoning as recorded

Non-zero when the measurement is incomplete, so a caller checking the exit code cannot
read a partial run as a clean one. A DO NOT SHIP is exit 0 — that is a successful
measurement with a negative answer, not a failure.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
