Draw the daily trading plan on TradingView charts. Usage: /draw [BTC|GOLD|SPX|all]

$ARGUMENTS is the symbol. Blank or "all" draws all three.

## ONE SCRIPT, NOT THREE. Do not draw per symbol.

All three charts live in ONE saved TradingView layout, and a layout holds one chart
state — so a per-symbol study applied in one tab propagates to the others and the
last one wins. That is not theory: the Gold chart rendered BTC's plan, levels and
all. `tradingview_bot.py plan` generates a SINGLE indicator that selects on
`syminfo.ticker`, so applying it once is correct on whichever symbol the chart shows
and a second copy becomes impossible to create.

An earlier version of this file told you to run `tradingview_bot.py draw [SYMBOL]
[entry] [stop] [target] ...` per symbol, and to drive Puppeteer at the Pine editor by
hand. Both are the discredited approach. Do not do either.

## The command

```
python tradingview_bot.py plan            # all three
python tradingview_bot.py plan GOLD       # one symbol
```

It reads `/api/signals`, `/api/strategy-settings` (the live gate — never hardcode it)
and `/api/market-context` itself. You do not need to fetch anything first.

Takes ~2.5 minutes because it drives a real browser over CDP. **Never run it from
anything with a timeout under 5 minutes** — the 60-second scheduled path passes
`--no-draw` for exactly this reason, and a kill mid-draw looks identical to a draw
that worked.

## Preconditions, in order

1. Server up on :3001. If not, stop and say so.
2. Edge on CDP port 9222. `tasks/launch_chrome_tv.bat` starts it;
   `tv_daily_plan.py::run_tv_draw` launches it automatically, this path does not.
3. Logged in to TradingView. `python tradingview_bot.py test` answers this.

## What gets drawn

**Only a real engine setup draws price LINES** — entry solid green, stop dashed red,
target dashed blue, plus the risk and reward bands. A WAIT chart gets no lines at
all, because a red dashed line with a pill reading "S2 4,458.07" looks exactly like a
stop loss and the qualifier that says otherwise lives twelve rows away in a table.

**Confluence zones draw on every chart, WAIT included**, as neutral orange boxes
labelled `x4 R` — the count is how many independent methods agree on that band. They
are never red or green: on this chart those colours already mean stop and target.

**The prior session** draws as one faint grey band, not two lines.

The panel carries 17 rows including `Zones` and `Day range`. The plan embeds its own
timestamp and prints **STALE in red** on the chart when it is more than 18 hours old,
so a missed run is visible on the chart itself rather than only in a log.

## Reading the result

The command reports what it could actually verify, which is narrower than it looks:

- "Save did not land" → the chart was left exactly as it was. Nothing drew.
- "Save landed but no plan study is on the chart" → add `JARVIS Daily Plan` to the
  layout once by hand; every run after that updates it in place.
- "ORPHAN plan study(ies)" → a study titled with a TIMESTAMP is backed by no saved
  script, so saving can never update it and it draws the old panel over the live one.
  It must be removed by hand. Relay the exact instructions the tool prints.
- A non-zero exit means a chart is erroring, not that nothing drew. Read the health
  sweep — it checks EVERY chart, because one chart's legend says nothing about the
  other two.

## Report

```
DAILY PLAN DRAWN — [symbols] — [date]
Levels source : confluence-zones | engine-pivots | round-numbers
Per symbol    : [BIAS] entry/stop/target, or WAIT
Zones         : R [price] x[N]   S [price] x[N]
Day range     : [N]% of ATR — [reading]
Chart health  : clean | [what is erroring, per symbol]
```

If the levels source is anything but `confluence-zones`, say which rung it fell to
and why — a thin plan must not read like a confident one.
