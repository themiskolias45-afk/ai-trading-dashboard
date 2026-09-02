---
decision_key: 9ecfd5f7bfa63b53
source: tasks/lab_drain.ps1:1
status: standing
recorded: 2026-09-02T17:54:29.703Z
---

# STANDING DECISION

IT NEVER THROWS. A scheduled task that exits non-zero raises an alarm, and an

Governs: `param(`

## The reasoning as recorded

============================================================================
 lab_drain.ps1 - the 24/7 lab cycle: GENERATE -> DRAIN -> PROMOTE

 Kept as ONE task rather than three. Three tasks would each carry their own
 IgnoreNew guard but nothing would stop a generate overlapping a drain, and two
 drains running together would execute one queued job twice and register it as two
 distinct runs - corrupting the trial count the entire lab rests on. One task, one
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
