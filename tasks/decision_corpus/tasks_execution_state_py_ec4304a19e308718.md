---
decision_key: ec4304a19e308718
source: tasks/execution_state.py:1
status: standing
recorded: 2026-09-08T03:37:10.852Z
---

# STANDING DECISION

UNKNOWN IS NEVER ZERO. Every section can be None, meaning "could not read", and the panel

Governs: `import io`

## The reasoning as recorded

EXECUTION STATE -> dashboard/execution-state.json

Everything that decides WHETHER a trade happens and HOW BIG it is, on one page, because
until now it was spread across six surfaces and no single one of them was complete:

  * /api/mt5/positions      shows only the BRIDGE's own magic - it held one SP500 trade
                            while MT5 held eight, so the EA's positions were invisible
                            to the dashboard BY CONSTRUCTION
  * the trade ledger        is built from MT5 deal history, so it cannot see TradingView
  * the weekly review       is the EA only, deliberately
  * strategy settings       give percentages, not the LOTS those percentages produce
  * the halt routes         are two separate systems that must BOTH be checked

So a reader could not answer the only questions that matter before a trade fires: can it
trade right now, what can place an order, and how big can one get?

READ-ONLY. Reads MT5, the settings API and the ledger; writes one JSON file. It places no
order, changes no setting, arms and disarms nothing. feedsTheGate is false and stays false.

UNKNOWN IS NEVER ZERO. Every section can be None, meaning "could not read", and the panel
renders that differently from empty. This whole file exists because things that could not
be seen were reported as fine.

  python tasks/execution_state.py           write the json
  python tasks/execution_state.py --json    print it, write nothing

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
