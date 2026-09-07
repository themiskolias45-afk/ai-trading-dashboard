Deep market context — confluence levels, the day's range, and the macro read. Usage: /context [BTC|GOLD|SPX|all]

$ARGUMENTS is the symbol. Blank or "all" reads all three.

## What this answers

Not "should I trade" — the gate answers that. This answers **where price is likely to
react, and how much room today has left**.

## The command

```
curl -s -H "Cookie: smartentry_session=$(cat server/session_secret.txt)" \
  http://localhost:3001/api/market-context
```

Session-gated. The MCP tools, `tv_daily_plan.py` and `tradingview_bot.py` all hold
their own login; a bare curl gets 401 and **a 401 means the check did not run**, not
that there is nothing there.

## STEP 0 — CHECK DATA GAPS FIRST (C3)

Before formatting any zone output, read `warnings` from the payload.

**If `warnings` is non-empty**, print the warnings block AT THE TOP of the report,
before all zone data, prefixed:
```
DATA GAPS ([N]): [warnings, verbatim]
```
If `warnings` contains `'no ATR'` or `'confluence clustering skipped'`, replace the
zone output section with:
```
Zone computation unavailable — missing ATR. Run /diagnose to check signal feed freshness.
```
A missing-ATR context that shows empty zone output without explanation reads identically
to a quiet market — the warning disambiguates which it is.

## STEP 1 — CROSS-REFERENCE SIGNAL DIRECTION (C1)

After fetching market-context, also fetch (no session cookie required):
```
GET http://localhost:3001/api/signals
```
For each asset that has a signal at or above the live gate:

- **BUY** and `nearestAbove.score ≥ 4` and `nearestAbove.distanceAtr < 0.5`:
  → `ENTRY CAUTION: x[N] resistance [distanceAtr] ATR above ([methods]) — feedsTheGate:false`
- **BUY** and `nearestBelow.score ≥ 4` and `nearestBelow.distanceAtr < 0.3`:
  → `SUPPORT NEARBY: x[N] floor [distanceAtr] ATR below ([methods]) — tight stop risk`
- **SELL** and `nearestBelow.score ≥ 4` and `nearestBelow.distanceAtr < 0.5`:
  → `ENTRY CAUTION: x[N] support [distanceAtr] ATR below ([methods]) — feedsTheGate:false`
- **priceInside** a zone with `score ≥ 4`:
  → `PRICE IN x[N] ZONE [low]–[high] — direction of break matters`

If `/api/signals` returns an error or no signal is above the gate, omit this block.

## STEP 2 — CONFLUENCE SCORECARD (C2)

Read `tasks/analysis/plan-scorecard.json` (relative to project root).

- File does not exist → append: `CONFLUENCE EVIDENCE: none yet — run: node tasks/plan_review.cjs daily`
- File exists → read `holdRateByConfluence`. For each score bucket:
  - coverage ≥ 8: `CONFLUENCE x[N]: [holdRate]% hold rate over [coverage] cases`
  - coverage < 8: `CONFLUENCE x[N]: TOO FEW ([coverage] cases — need ≥8)`
- If no bucket clears n=8: `CONFLUENCE: [total] cases tracked — no bucket validated yet`

This answers whether the scoring is actually predictive. Until a bucket clears n=8, the
score is a description, not a forecast.

## How to read it

**`zones.byConfluence`** — the whole point. Each zone is a price band with a `score`
counting how many DISTINCT method families agree on it, out of eight: prior-period,
pivot, swing, moving-average, bollinger, round-number, fair-value-gap, atr-projection.

- A `x1` zone is one method talking to itself. Ignore it.
- A `x4`+ zone is where four unrelated ways of finding a level landed in the same
  band. That is the thing worth watching.
- The score counts FAMILIES, not members. Three pivots stacked together score 1, on
  purpose — pivot arithmetic agreeing with itself is not confluence.

**`zones.nearestAbove` / `nearestBelow` / `priceInside`** — what price has to deal
with next. `distanceAtr` is the distance in ATR units, so it is comparable across
assets: 0.2 ATR is close on BTC and close on SPX, 200 points is neither.

**`projection.rangeUsedPct`** — how much of a normal day's ATR range today has already
travelled, with a plain-words reading. Over 100% means a normal day is already done.
It is a DESCRIPTION. It suppresses nothing, the engine never sees it, and a day at
180% is still a day the engine may fire on.

**`macro`** — VIX regime in words, DXY with a DIRECTION (not just a level), and 30-day
return correlations. Anything under |r| = 0.3 is reported as UNCOUPLED rather than as
a weak relationship, because a weak r on 30 samples is noise with a decimal point.

**`warnings`** — these appear at the TOP of the report (STEP 0). A context with no
swings because the series was too short and a context with no swings because the market
made none look identical without the warning.

## Hard rule

`feedsTheGate` is `false` on every object in this payload and stays false. None of
this reaches confidence, sizing, stops or any order. FVG has no measured edge (6.9pp
worse than random over ~6,800 samples) and CRT is CLOSED as an engine input after six
negative measurements. They appear here as context and may not be promoted out of it.

## Report

```
CONTEXT — [symbol] — [price], ATR [n]
DATA GAPS ([N]): [warnings]              ← STEP 0: top if warnings non-empty
ENTRY CAUTION / SUPPORT NEARBY: [...]   ← STEP 1: signal vs zone alignment
CONFLUENCE EVIDENCE: [scorecard]        ← STEP 2: holdRateByConfluence
Above : [low]–[high]  x[N] [methods]  [d] ATR away
Below : [low]–[high]  x[N] [methods]  [d] ATR away
Inside: [band] x[N]                      (only when price is in a zone)
Day   : [N]% of ATR — [reading]   band [low]–[high]
Prior : day [low]–[high]   week [low]–[high]
Macro : [VIX regime] | [DXY direction] | [correlations]
```
