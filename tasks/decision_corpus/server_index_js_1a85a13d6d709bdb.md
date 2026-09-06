---
decision_key: 1a85a13d6d709bdb
source: server/index.js:6500
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

`tradingControl` -- the dashboard kill switch, POST /api/mt5/control -- NEVER reaches

Governs: `app.get("/api/risk-status",  (_, res) => res.json(riskStatus));`

## The reasoning as recorded

THIS IS THE CIRCUIT BREAKER, NOT THE KILL SWITCH, AND THEY ARE SEPARATE STATE.
`riskStatus` is built from what the bridges push up (consecutive losses per account).
`tradingControl` -- the dashboard kill switch, POST /api/mt5/control -- NEVER reaches
this payload, by design: they answer different questions.

The trap that cost on 2026-09-02: mt5_bridge.py reads /api/mt5/control, so the kill
switch stopped the bridges. The three executors read ONLY this route, so it did not
reach them, and on the day all three were armed the switch covered 2 of 5 order paths.
A switch that stops some of them is worse than one that stops none, because you believe
you are flat and may trade manually on top of positions that are still opening.

ANY COMPONENT THAT CAN PLACE AN ORDER MUST CHECK BOTH AND FAIL CLOSED ON EITHER.
tasks/fvg_executor.py trading_halted() is the reference implementation.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
