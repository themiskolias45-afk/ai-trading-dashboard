---
decision_key: 5df9cd278b5f8f20
source: tasks/ea_crt_backtest.cjs:70
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

NEVER compare a Model=1 run against a Model=4 run. The modelling difference is a

Governs: `const MODEL = strArg('--model', null);`

## The reasoning as recorded

Tester modelling quality. 4 = every real tick (what the whole campaign used), 1 = 1-minute
OHLC. Model 1 exists here for ONE reason: local tick files only span 202504-202609, while
the server offers history from 2022.11.15. Reaching that history on real ticks means a
multi-GB download; on M1 bars it does not.

NEVER compare a Model=1 run against a Model=4 run. The modelling difference is a
confound, and mixing them silently is how a "result" becomes an artefact of fill
assumptions. Establish a same-window Model=1 control first, then compare Model 1 to
Model 1 only.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
