---
decision_key: fe1a24e31c242d76
source: tasks/h1_strategies_backtest.cjs:87
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

OPT-IN, NEVER THE DEFAULT. _cost_basis.cjs states what this basis is and is not:

Governs: `const COST_BASIS = String(opt("--cost-basis", "flat")).toLowerCase();`

## The reasoning as recorded

--cost-basis perasset charges each trade its own instrument's SPREAD over that
trade's own risk distance, instead of one flat number for three instruments whose
spreads differ by orders of magnitude.

OPT-IN, NEVER THE DEFAULT. _cost_basis.cjs states what this basis is and is not:
spread is a FLOOR on cost. Commission, swap on a held position and slippage on a
stop through a fast market are all real and NONE is modelled here. Its own warning
is that a harness switching to spread-only costs and reporting a better number
"has not found edge, it has stopped paying for things that still cost money".

It understates MORE for this strategy than for most: HOLD_BARS is 24 H1 bars, so a
position routinely sits overnight and pays SWAP - precisely one of the components
spread alone does not capture.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
