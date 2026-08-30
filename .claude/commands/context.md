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

**`warnings`** — read these before the numbers. Every leg that came back empty is
named. A context with no swings because the series was too short and a context with no
swings because the market made none look identical without this.

## Hard rule

`feedsTheGate` is `false` on every object in this payload and stays false. None of
this reaches confidence, sizing, stops or any order. FVG has no measured edge (6.9pp
worse than random over ~6,800 samples) and CRT is CLOSED as an engine input after six
negative measurements. They appear here as context and may not be promoted out of it.

## Is any of it actually predictive?

That is being measured, and it is honest to say it is not settled yet:

```
node tasks/plan_review.cjs --summary
```

`holdRateByConfluence` is the answer when the sample arrives — hold rate bucketed by
score, so `x5` can be compared with `x2` directly. **Read `coverage` first**: it is
the denominator, and a rate under n=8 prints as TOO FEW TO JUDGE and is not evidence.

## Report

```
CONTEXT — [symbol] — [price], ATR [n]
Above : [low]–[high]  x[N] [methods]  [d] ATR away
Below : [low]–[high]  x[N] [methods]  [d] ATR away
Inside: [band] x[N]                      (only when price is in a zone)
Day   : [N]% of ATR — [reading]   band [low]–[high]
Prior : day [low]–[high]   week [low]–[high]
Macro : [VIX regime] | [DXY direction] | [correlations]
Thin because: [any warnings, verbatim]
```
