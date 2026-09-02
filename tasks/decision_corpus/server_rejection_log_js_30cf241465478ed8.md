---
decision_key: 30cf241465478ed8
source: server/rejection_log.js:89
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

The instrument the levels were priced on. NEVER score off `ticker`: it is

Governs: `sourceSymbol: trimmedOrNull(record.sourceSymbol),`

## The reasoning as recorded

The instrument the levels were priced on. NEVER score off `ticker`: it is
always the Yahoo symbol regardless of which feed supplied the bars, and GC=F
futures sat ~$60 from XAUUSD spot when the first rows were written.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
