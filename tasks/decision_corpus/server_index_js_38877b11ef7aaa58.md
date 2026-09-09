---
decision_key: 38877b11ef7aaa58
source: server/index.js:1988
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

DO NOT change this default to "trend" without a walk-forward that clears on its WORST

Governs: `const MACD_BULLISH_MODE = "signal";`

## The reasoning as recorded

WHICH QUESTION `macd.bullish` ASKS. "signal" is the live rule and the default:
MACD above its signal line, i.e. momentum ACCELERATING. "trend" is the candidate under
measurement: accelerating OR simply above zero, i.e. a genuine uptrend that may be
catching its breath. Declared as a const rather than read from the environment so
tasks/_replay_mtf.cjs can override it through SCALAR_CONSTS — the replay sandbox has no
`process` global, and an env read here threw on 35,467 steps before this was corrected.

DO NOT change this default to "trend" without a walk-forward that clears on its WORST
fold. Removing the MACD condition entirely was already measured and makes Gold and
SP500 worse; this candidate is deliberately weaker than removal — MACD below zero
stays blocked — but weaker is not the same as proven.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
