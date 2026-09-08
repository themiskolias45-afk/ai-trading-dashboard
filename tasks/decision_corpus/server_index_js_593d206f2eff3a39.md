---
decision_key: 593d206f2eff3a39
source: server/index.js:1411
status: standing
recorded: 2026-09-08T03:37:10.852Z
---

# STANDING DECISION

49x leverage. DO NOT READ 10 AS THE LIVE CEILING - `def` is a default, and the live

Governs: `maxNotionalPct: { min: 1, max: 100, def: 25, decimals: 1 },`

## The reasoning as recorded

NOTIONAL exposure ceiling, in PERCENT of balance, applied per symbol by the bridge.

maxLotSize above is ONE number for instruments whose contract value differs by 57x.
Measured 2026-09-06 on a GBP 89,677 account: one lot is GBP 443,131 of gold, 79,746 of
BTC, 7,714 of SP500. At the table default of 10 that permitted 4.43 MILLION of gold,
49x leverage. DO NOT READ 10 AS THE LIVE CEILING - `def` is a default, and the live
value is whatever /api/strategy-settings serves (2 on both boxes as of 2026-09-06,
i.e. ~886k of gold, ~10x). Quoting a config number in a comment is how CLAUDE.md came
to insist the gate was 65 for a week after it moved.
Set it low enough for gold and every SP500 trade dies (they size to 1.90 lots); set it
high enough for SP500 and gold still takes 10x. No single lot number is correct, which
is why this second ceiling is denominated in MONEY.

MINIMUM IS 1, NOT 0, AND THAT IS THE WHOLE POINT. The bridge treats 0 as "cap off"
(`if notional_pct > 0`). With min 0 and decimals 1, clampStrategyValue rounds anything
under 0.05 to exactly 0 - so a request for the TIGHTEST possible cap would have
silently produced NO CAP AT ALL, and `{"maxNotionalPct": null}` would have done the
same, since Number(null) is 0. A risk limit that fails OPEN on a small or malformed
value is worse than no limit, because it reads as armed. With min 1 that is
unreachable: to effectively disable it, set 100, which still bounds a runaway
(100% of balance is ~90k; an uncapped near-zero-stop order asked for 22 MILLION).

It SIZES DOWN and never refuses - the broker minimum stays the floor - so it cannot
block a signal, suppress a confidence value or cost a learning row.

Listed HERE because loadStrategySettings iterates Object.keys(STRATEGY_LIMITS): a key
absent from this table cannot be set by anything. And it must ALSO be in the bridge's
refresh_strategy_settings allowlist, or it is settable, persisted, served and compared
while the thing that sizes the order never reads it.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
