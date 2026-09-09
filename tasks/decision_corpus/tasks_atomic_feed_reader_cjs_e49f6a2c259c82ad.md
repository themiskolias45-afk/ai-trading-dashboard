---
decision_key: e49f6a2c259c82ad
source: tasks/atomic_feed_reader.cjs:1
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

WHAT IT MUST NEVER DO: influence a signal. The payload carries feedsTheGate:false and

Governs: `const fs = require("fs");`

## The reasoning as recorded

ATOMIC ANALYST FEED READER — ships the indicator's JSON into the server.

WHY A READER AND NOT A DIRECT POST. MQL5 forbids WebRequest() inside an indicator: the
call returns -1 with error 4014, "function not allowed for call". Only EAs and scripts
may use it. ATOMIC_ANALYST_V84 is deliberately an INDICATOR - it has no trade functions
available to it at all, so it cannot place, modify or close an order even by mistake,
and it does not occupy the chart's expert slot. The price of that safety is that it
writes a file and something else carries it. This is that something else.

WHAT IT IS ALLOWED TO DO: read files, POST them to /api/atomic/verdict, exit.
WHAT IT MUST NEVER DO: influence a signal. The payload carries feedsTheGate:false and
the endpoint stores it beside the engine, never inside it. This is a second opinion from
an unvalidated third-party indicator; wiring it into confidence, the 70 gate, position
size or a stop would put a paper read on the live decision path, which is exactly the
mistake `shadow` is kept separate to avoid.

STALENESS IS REPORTED, NEVER HIDDEN. The MT4 panel this ports from showed a ticket
stamped four days earlier underneath a live-looking header. Every record shipped here
carries its own age and the server marks it stale rather than serving it as current.

  node tasks/atomic_feed_reader.cjs           read, ship, report
  node tasks/atomic_feed_reader.cjs --dry     read and report, ship nothing

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
