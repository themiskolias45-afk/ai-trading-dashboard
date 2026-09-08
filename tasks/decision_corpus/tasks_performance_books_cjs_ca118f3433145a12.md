---
decision_key: ca118f3433145a12
source: tasks/performance_books.cjs:1
status: standing
recorded: 2026-09-08T03:37:10.852Z
---

# STANDING DECISION

They are NEVER POOLED here and never will be. A single total across three systems on two

Governs: `const fs = require("fs");`

## The reasoning as recorded

THE THREE BOOKS -> dashboard/performance-books.json

The Performance page reads /api/journal, which is SmartEntry only. So it presents one
book as though it were the whole picture, while two others exist and are invisible there:

  SmartEntry   the bridge and its executors        -602.52 GBP over 25 closed
  EA CRT       the chart EA, its own magics        -457.52, ALL of it pre-fix
  TradingView  a separate paper account entirely   -3,607.89 realised

They are NEVER POOLED here and never will be. A single total across three systems on two
platforms describes none of them, and it would bury the one fact that matters most.

THAT FACT: the system is PROFITABLE IN R AND LOSING IN MONEY. Both numbers are already in
the journal - realizedR sits on every row beside pnl - and the page shows neither together
nor per asset. Money is what the account feels; R is what the strategy earned. When they
disagree the difference is position sizing, not edge, and you cannot see that disagreement
on any page today.

READ-ONLY. Reads the journal API and two JSON files this system already publishes; writes
one file. No order, no setting, no gate. feedsTheGate is false and stays false.

UNKNOWN IS NOT ZERO. Any book that cannot be read comes back null and is rendered as
"could not read", never as a zero that would quietly flatter the total.

  node tasks/performance_books.cjs          write the json
  node tasks/performance_books.cjs --json   print it, write nothing

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
