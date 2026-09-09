---
decision_key: cb8bb56b33de17e5
source: mt5_bridge.py:1320
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

IT SIZES DOWN, IT NEVER REFUSES. The broker minimum below is still the floor, so a

Governs: `notional_pct = float(strategy_settings.get("maxNotionalPct", 25) or 0)`

## The reasoning as recorded

NOTIONAL EXPOSURE CAP -- the one maxLotSize cannot be.

A single lot number cannot protect instruments whose contract value differs by 57x.
Measured 2026-09-06 on a GBP 89,677 account: ONE lot is GBP 443,131 of gold, GBP 79,746
of BTC, GBP 7,714 of SP500. maxLotSize was 10, i.e. 4.43 MILLION of gold - 49x leverage,
the account gone in one trade. Cap it low enough for gold and every SP500 trade dies
(they legitimately size to 1.90 lots); cap it high enough for SP500 and gold can still
take 10x. There is no correct single number, which is why this cap is in MONEY.

IT SIZES DOWN, IT NEVER REFUSES. The broker minimum below is still the floor, so a
capped trade is a smaller trade, never a missing one - no signal, no confidence value
and no learning row is lost. That is the whole point: the runaway case is impossible
while the ordinary case is untouched.

LATENT, NOT ACTIVE. raw_lots = risk_amount / value_per_lot is already correct and is
why gold gets 0.02 and SP500 gets 1.90 - all three sit far under this cap and are
unaffected. It only bites when something upstream breaks, and server/index.js:3707
names that case: a small stop distance "would size the position into the maxLotSize
ceiling". This is the backstop for exactly that.

UNKNOWN PRICE MEANS SKIP, NOT GUESS. Without a contract size or an entry price the
exposure cannot be computed, so the cap steps aside and maxLotSize above still applies.
Inventing a number here would be worse than the gap it fills.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
