---
decision_key: 4adf11b13f19ebea
source: tasks/rag_query.py:123
status: standing
recorded: 2026-09-02T18:12:00.722Z
---

# STANDING DECISION

A MATCHING STANDING DECISION IS NEVER CUT BY top_k.

Governs: `top = results[:top_k]`

## The reasoning as recorded

A MATCHING STANDING DECISION IS NEVER CUT BY top_k.

The truncation used to happen here, before anything could notice what was being
dropped. Measured 2026-09-02 on the real query "is it ok to add price level lines to
the chart": two brain memories scored 0.509 and 0.446, and the STANDING DECISION
forbidding exactly that scored 0.367 and fell outside --top 3. On that day all three
said the same thing, which was luck. The next time a memory of what was LEARNED
outranks a rule about what was SETTLED, the one that got cut is the one that decides
whether the change is permitted.

So the top_k cut applies to the ranked list, and any decision that cleared the
similarity floor is added back. It can only ever ADD rows, never displace one.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
