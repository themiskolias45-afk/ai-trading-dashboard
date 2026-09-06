---
decision_key: 2984f0a57e5bb7bd
source: server/calendar_projection.js:1
status: standing
recorded: 2026-09-04T06:15:50.682Z
---

# STANDING DECISION

A PROJECTED EVENT MUST NEVER STOP A TRADE. These rows are never merged into newsCache,

Governs: `"use strict";`

## The reasoning as recorded

PROJECTED high-impact releases, so the system can see past the end of the weekly feed.

WHY THIS EXISTS. ff_calendar_thisweek.json is the only calendar feed available - nextweek,
lastweek and thismonth all 404 - so the real horizon is one week and it SHRINKS as the
week runs. On a Thursday the system sees under a day ahead; from Friday evening through
the weekend it sees nothing. That is not enough to answer "what is coming next week".

The releases that actually create blackouts are not random: they are published on fixed
calendar rules. Those rules are encoded here and projected forward.

── THE SAFETY PROPERTY, AND IT IS THE WHOLE DESIGN ──────────────────────────────────
A PROJECTED EVENT MUST NEVER STOP A TRADE. These rows are never merged into newsCache,
which is what isNewsBlackout() reads, so nothing here can gate an entry, move a
threshold or suppress a setup. They are planning information and nothing else.

The reason is simple: a projection is a guess about a date. A guess that blocks trading
is a guess that costs money, silently, on a day nobody checks. A guess that only informs
a plan costs nothing when it is wrong. Every row is stamped `projected: true` so no
downstream reader can mistake one for an observation.

── HOW THEY CHECK THEMSELVES ────────────────────────────────────────────────────────
Every projection that falls inside the period the accumulated store already covers is
compared against it. If the real event is there, the projection is marked confirmed. If
the store covers that date and the event is ABSENT, it is marked contradicted - which is
how a rule that has drifted announces itself instead of quietly going wrong.

Validated on real data before shipping (tasks/calendar_store.json, September 2026):
  Non-Farm Employment Change, Average Hourly Earnings, Unemployment Rate
    -> all three 2026-09-04 12:30 UTC, and 2026-09-04 is the first Friday. Rule holds.
  ISM Manufacturing PMI
    -> 2026-09-01 14:00 UTC, and 2026-09-01 is the first business day. Rule holds.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
