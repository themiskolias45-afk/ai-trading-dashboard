---
decision_key: e038a288537b6724
source: server/index.js:8430
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

the blackout NEVER FIRED — not once in this system's life — while

Governs: `const market = String(ev.country ?? ev.currency ?? "").toUpperCase();`

## The reasoning as recorded

ev.COUNTRY, not ev.currency.

This filter read ev.currency, which does not exist on this feed: 0 of 74 events
carry it and all 74 carry ev.country. `relevant` was therefore always empty and
the blackout NEVER FIRED — not once in this system's life — while
/api/newsfilter reported enabled:true and the bridge treated that as protection.
Found 2026-08-12, a day with four high-impact USD CPI prints at 12:30 UTC that it
was completely blind to.

Both fields are read so a feed that renames it back cannot silently re-break
this. XAU is kept in the watch list but never matches: the feed's country codes
are AUD CAD CHF CNY EUR GBP JPY NZD USD, with no metals. USD is what actually
moves XAUUSD, so USD coverage is the point.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
