---
decision_key: cefee3c49aa1b21f
source: server/index.js:3973
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

Do not re-open this on a bar-return result alone.

Governs: `const MOMENTUM_REQUIRE_MACD_BULLISH = true;`

## The reasoning as recorded

Does MOMENTUM still require macd.bullish? MEASURED 2026-09-01 and set to false.

Gold sat in a STRONG UPTREND above EMA20 (4443.54 / 4432.64) and above EMA50, RSI
53.9 well inside the 52-88 band, and failed MOMENTUM on macd.bullish AND NOTHING
ELSE. That is the condition, not the gate and not the RSI band.

`node tasks/ceiling_measure.cjs --setup momentum_macd --floor 52 --ceiling 88`
over 2,966 bars where every other MOMENTUM condition passes:

  FIRED   (MACD bullish, what the engine took)  1992 bars  +0.592 ATR  60.8% win
  BLOCKED (MACD bearish, what it refused)        974 bars  +0.523 ATR  58.3% win
  BLOCKED minus FIRED  -0.069 ATR  against a noise band of +/-0.094

INSIDE THE NOISE. This is not "it costs money" like the BUY_DIP case at 3.0x the
band - it is a WELL-POWERED NULL at n=2966. The condition buys no measurable edge
and discards 33% of MOMENTUM's candidates (278 of Gold's 939) to do it. Sample size
is the binding constraint on this system, so dropping a filter that provably adds
nothing while removing a third of the flow ADDS signal at no measured cost. That is
the only justification claimed here: MORE TRADES, NOT BETTER ONES.

Honest caveat: both groups underperform the unconditioned control (-0.122 and
-0.191 ATR). MOMENTUM's forward-return profile is weak on this horizon regardless
of MACD; this changes the flow, not that.

MOMENTUM CARRIES THE BOOK - 450 trades, +0.309 R/trade, removing it costs -0.2822
in 0/5 folds - so a bar-return null was NOT considered sufficient on its own. The
walk-forward on realised R was re-run immediately after this change and compared
against the pre-change baseline recorded the same day (gate 70, MAX_HOLD=320:
XAUUSD 5/5 +0.051, BTCUSD 5/5 +0.172, SP500 4/5 -0.042). See the commit for the
after-numbers. Flip to true to restore the old behaviour.
REVERTED TO TRUE, 2026-09-01, within the hour, by the walk-forward above.
The bar-return null was real but it was the WRONG INSTRUMENT: forward return on a
bar has no stop, no target and no position sequencing. Realised R at gate 70,
MAX_HOLD=320, before -> after with this false:
  XAUUSD  5/5 ROBUST worst +0.051  ->  4/5 worst -0.357
  BTCUSD  5/5 ROBUST worst +0.172  ->  4/5 worst -0.003
Both assets fell out of ROBUST. "Where the ledger contradicts a walk-forward, the
walk-forward wins" — and a bar-return screen is weaker evidence than either.
Do not re-open this on a bar-return result alone.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
