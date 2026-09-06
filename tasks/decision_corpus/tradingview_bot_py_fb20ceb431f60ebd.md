---
decision_key: fb20ceb431f60ebd
source: tradingview_bot.py:355
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

VERIFY, DO NOT ANNOUNCE. This printed success unconditionally, and on the VPS it

Governs: `if is_logged_in(page):`

## The reasoning as recorded

VERIFY, DO NOT ANNOUNCE. This printed success unconditionally, and on the VPS it
said "Logged in manually - session saved" at a moment when the page still carried
class="is-not-authenticated". A save of an anonymous session is not a login.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
