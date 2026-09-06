---
decision_key: fcb3bb51c90c5de4
source: tasks/safe_bridge_restart.cjs:429
status: standing
recorded: 2026-09-04T06:15:50.682Z
---

# STANDING DECISION

DO NOT GUESS THE STATE HERE. This used to print "The bridge may now be DOWN"

Governs: `let stillUp = null;`

## The reasoning as recorded

DO NOT GUESS THE STATE HERE. This used to print "The bridge may now be DOWN"
and point at start_bridge_<A>.bat. Measured 2026-08-27 on the laptop: the kill
failed with "Access is denied" because the bridge runs ELEVATED and this script
does not, so the process was never touched and the bridge was still up, still
pushing candles, still holding both positions. The message said the opposite of
the truth in the ONE direction that causes damage - it invites starting a
SECOND --auto bridge on an account that already has one, and two bridges on one
account double every order. See [[one_auto_bridge_per_account]] and
[[laptop_bridge_cannot_be_restarted_unelevated]].

A failed Stop-Process almost always means NOTHING was stopped. Ask the health
route instead of asserting, and only ever suggest starting a bridge once the
route has confirmed there is none.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
