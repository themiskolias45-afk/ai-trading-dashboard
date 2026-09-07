---
decision_key: 47daf0185497cfe1
source: server/index.js:6338
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

CLASSIFY BY MAGIC HERE, DO NOT TRUST THE ROW TO CARRY IT.

Governs: `const OWN_MAGICS = {`

## The reasoning as recorded

CLASSIFY BY MAGIC HERE, DO NOT TRUST THE ROW TO CARRY IT.

The bridge tags each row owner/model, but only since today - and the process actually
running predates that, so its rows arrive with owner undefined. Untagged rows were
falling straight through this filter and a third-party EA (magic 996142) appeared on
the laptop page. Restarting the bridge would fix the tagging; deriving it here fixes
it without one, and keeps working if a future bridge ever stops sending the field.

The allow-list is THIS SYSTEM'S magic numbers and nothing else. Anything not on it is
dropped, whatever appears on the account and whoever put it there.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
