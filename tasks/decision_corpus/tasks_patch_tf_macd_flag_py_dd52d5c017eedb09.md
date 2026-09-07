---
decision_key: dd52d5c017eedb09
source: tasks/patch_tf_macd_flag.py:32
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

DO NOT flip this on a bar-return screen. That instrument gave the WRONG ANSWER TWICE on

Governs: `""".rstrip("\n")`

## The reasoning as recorded

Does TREND_FOLLOW still require macd.bullish? UNTIL 2026-09-02 THIS WAS NOT EVEN A
QUESTION ANYONE COULD ASK -- the condition was inline with no name, so no harness could
flip it and no measurement could reach it.

It is the LARGEST SINGLE BLOCKER IN THE CENSUS: 24 of the 92 rows in
tasks/near_misses.jsonl are TREND_FOLLOW dying on MACD_NOT_BULLISH and nothing else,
ahead of RANGE_TRADE_SHORT's RSI floor (23) and both RSI ceilings (14 each). BUY_DIP
and MOMENTUM each got a flag and a measurement on 2026-09-01; this one got neither,
and it is the condition actually holding Gold and SP500 at confidence 0 -- SP500's
daily MACD sat under its signal line for TEN consecutive bars from 2026-08-20.

TRUE REPRODUCES THE LIVE ENGINE EXACTLY. The flag exists so the two worlds can be
replayed and compared instead of argued about. tasks/_replay_mtf.cjs flips it via
MTF_TREND_FOLLOW_REQUIRE_MACD, measurement-only; the server is never edited to run a
measurement.

DO NOT flip this on a bar-return screen. That instrument gave the WRONG ANSWER TWICE on
2026-09-01 -- it cleared BUY_DIP and MOMENTUM, both were flipped false, and the
per-asset walk-forward on realised R reverted both within the hour, because a forward
return on a BAR has no stop, no target and no position sequencing.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
