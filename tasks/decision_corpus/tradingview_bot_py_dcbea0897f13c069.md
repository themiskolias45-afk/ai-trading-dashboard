---
decision_key: dcbea0897f13c069
source: tradingview_bot.py:253
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

ASK TRADINGVIEW, DO NOT INFER FROM A BUTTON.

Governs: `try:`

## The reasoning as recorded

ASK TRADINGVIEW, DO NOT INFER FROM A BUTTON.

The sign-in-control test gives a FALSE POSITIVE, measured on the Contabo VPS
2026-09-05: a freshly created profile that had never signed in reported
count == 0, so this function returned True, login() printed "Already logged in"
and skipped, and the bot went on to draw as a guest. The page's own markup said
the opposite at the same moment:

    <html class="is-not-authenticated is-not-pro theme-dark">

and the cookie jar held only analytics and consent cookies. That class is set by
TradingView itself, so it cannot drift the way a data-name attribute does - which
is the exact reason the old comment gave for abandoning the user-menu selector.

Both markers are consulted: the class is authoritative when present, and the
button check still catches a page that renders a sign-in prompt without it.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
