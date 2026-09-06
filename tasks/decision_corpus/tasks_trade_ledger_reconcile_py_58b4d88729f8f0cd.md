---
decision_key: 58b4d88729f8f0cd
source: tasks/trade_ledger_reconcile.py:1
status: standing
recorded: 2026-09-05T02:04:41.721Z
---

# STANDING DECISION

NEVER LOSES DATA Append-only. It reads the existing ledger, keys on position id, and

Governs: `import json, os, sys`

## The reasoning as recorded

Records EVERY closed trade on the attached terminal to tasks/all_trades_ledger.jsonl.

WHY THIS EXISTS. On 2026-09-04 the FVG executor placed a real XAUUSD trade (0.88 lots,
ticket 1935787113, magic 20260902) that closed in profit. The profit was recorded
NOWHERE in SmartEntry:
  - mt5_bridge.py is the only writer of /api/journal, and it filters every position path
    to magic 20250101, so an executor trade never reaches the journal.
  - tasks/fvg_executor.py is deliberately isolated: "It never reads or writes the
    engine's signal path, its settings, or its journal."
  - tasks/fvg_executed.jsonl records PLACEMENT only - no exit, no P/L (server/index.js
    :5872 says exactly this).
  - No outcomes ledger existed for ANY executor (tk_, fvg_, crt_ - checked, none).
So the only copy of that result was MT5's own deal history. A system cannot learn from
trades it does not know ended.

WHAT IT DOES. Sweeps MT5 deal history for EVERY magic - the bridge's, the executors',
the chart EAs', third-party ones - groups deals into closed positions, and appends the
ones it has not seen before.

GUARANTEES, in the order they were asked for:
  NEVER LOSES DATA   Append-only. It reads the existing ledger, keys on position id, and
                     appends only unseen rows. It never rewrites, truncates or reorders a
                     line it did not just write. Existing rows are never revisited.
  NEVER DELETES      It opens exactly one file for writing - its own, in append mode -
                     and creates it if missing. No unlink, no truncate, no os.replace
                     over anything that already held data.
  NEVER BLOCKS       Read-only against MT5: history only, no order, no stop, no close.
                     It touches no gate, no threshold, no setting, no signal path and no
                     other ledger. Nothing waits on it; if it fails, trading is unchanged.
  RECORDS EVERY TRADE  No magic filter. The blindness being fixed here was caused by a
                     magic filter, so this deliberately has none.

Re-runnable as often as you like: a second run on unchanged history appends nothing.

A bare initialize() attaches to whichever terminal answers first, so every row carries
the login it was actually read from - a ledger that does not say which account it
describes is worse than none.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
