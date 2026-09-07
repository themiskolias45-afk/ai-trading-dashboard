---
decision_key: 7d6ed08d4bc3f676
source: claude_agent.py:173
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

expiry NEVER DOES. It waits on a human. So it parks on a slow cadence rather than a

Governs: `AUTH_MARKERS = (`

## The reasoning as recorded

The CLI cannot authenticate at all. A THIRD class, and it is neither of the other two.

On 2026-08-28 the VPS daily check and morning agent both died on "Failed to
authenticate: OAuth session expired and could not be refreshed". park() looked at that,
found no limit marker and no transient marker, correctly said "that run was not stopped
by the session limit" and DESTROYED THE BRIEF — which is precisely the failure the queue
was built to prevent, surviving in the one wording nobody had seen yet. The same lesson
as the weekly-limit gap of 2026-08-12: this list is a guess about someone else's copy.

It differs from a limit in the thing that matters: a limit clears ON ITS OWN and an auth
expiry NEVER DOES. It waits on a human. So it parks on a slow cadence rather than a
tight one, and the message must name the action instead of saying "try later", which
would be a lie.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
