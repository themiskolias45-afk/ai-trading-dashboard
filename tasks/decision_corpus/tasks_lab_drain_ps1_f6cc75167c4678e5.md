---
decision_key: f6cc75167c4678e5
source: tasks/lab_drain.ps1:8
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

IT NEVER THROWS. A scheduled task that exits non-zero raises an alarm, and an

Governs: `param(`

## The reasoning as recorded

instance, strict order.
============================================================================

 What the scheduled task actually executes. It exists as its own file rather
 than a long -Argument string so the work is readable, loggable, and can be run
 by hand identically to the way the scheduler runs it.

 WHY IT IS BOUNDED. This runs on a box that trades. One candidate is ~0.3s
 today, but a queue is however long somebody made it, and a strategy added next
 month may not be cheap. -Max caps the work per tick; the scheduled task ALSO
 caps wall time, so two independent limits have to fail before this can matter.

 IT TOUCHES NOTHING LIVE. lab_queue.cjs reads historical CSVs and writes
 artifacts under tasks/analysis/lab. No gate, threshold, position size or stop
 is reachable from it, and it never contacts the broker.

 IT NEVER THROWS. A scheduled task that exits non-zero raises an alarm, and an
 alarm for "the queue was empty" is noise that trains people to ignore the log.
 Every failure is written to the log and the exit code stays 0 unless node
 itself could not be started at all.
============================================================================

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
