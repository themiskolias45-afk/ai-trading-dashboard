Full TradingView management. Usage: /tv [action]

Actions:
  /tv plan [symbol]   — draw the daily plan on the charts (the main one; see /draw)
  /tv context         — confluence levels + macro read, no browser (see /context)
  /tv pine            — generate the Pine source to a file, no browser
  /tv watch           — one intraday pass: what has crossed since the last check
  /tv review          — grade past plans; are the levels any good?
  /tv alert [sym] [price]
  /tv login           — test the TradingView session
  /tv health          — is the plan study on every chart, and is it erroring?

No action given: run `/tv plan`.

## /tv plan [symbol]

```
python tradingview_bot.py plan [all|BTC|GOLD|SPX]
```

ONE script covering all three symbols, selecting on `syminfo.ticker`. Never draw per
symbol — all three charts share one saved layout, and a per-symbol study propagates
between them, which is how the Gold chart ended up rendering BTC's plan. ~2.5 minutes;
never call it from anything with a timeout under 5 minutes. Full detail in `/draw`.

## /tv context

Read `/api/market-context`. No browser, instant. See `/context` for how to read it.

## /tv pine

Generate the Pine source without touching the browser:

```
python -c "import tradingview_bot as tv; \
  s=tv._get_json('/api/signals'); g,_=tv.fetch_live_gate(); \
  c=tv.load_market_context(); r=tv.load_candle_reads(); \
  print(tv.generate_pine([tv.build_plan(n,s[k],g,reads=r,context=c.get(k)) \
    for n,k in tv.API_ASSETS.items() if s.get(k)]))"
```

`tradingview_bot.py plan` also writes the exact source to
`tasks/pine_daily_plan_current.pine` BEFORE it touches the browser — that file is the
manual-recovery paste target when the editor has to be cleared by hand.

`tradingview_bot.py pine [SYM] [entry] [stop] [target]` still exists for a
hand-specified single plan. It carries no market context and no zones.

## /tv watch

```
node tasks/plan_monitor.cjs
```

One pass. Reports CROSSINGS since the last pass, not states — plan entry/stop/target
crossed, a confluence zone entered or left, the day passing 100% of its ATR range,
and confidence crossing the live gate. The first pass of a day records a baseline and
asserts nothing, which is correct: with no previous observation there is no crossing.

Exit 0 means the pass completed, event or no event. Exit 1 means it could not run.

To loop it, use `/loop 15m /tv watch` rather than adding a scheduled task.

## /tv review

```
node tasks/plan_review.cjs            # grade every ungraded complete day
node tasks/plan_review.cjs --summary  # print the scorecard only
```

Grades finished days against the bars the bridge already pushed. **Read `coverage`
first** — it is the denominator, and 25 of the first 39 asset-days published no level
at all because those plans carry `price:null` from the daily-plan outage. A rate under
n=8 prints TOO FEW TO JUDGE and is not evidence.

Never grades today: a forming bar has no final close.

## /tv alert [sym] [price]

```
python tradingview_bot.py alert [sym] [price] "SmartEntry alert - JARVIS"
```

## /tv login

```
python tradingview_bot.py test
```

If `keys.env` has no `TV_USERNAME`, run `tasks\setup_tradingview.bat` first.

## /tv health

The plan study can be PRESENT and BROKEN at the same time, and presence was all that
used to be checked — a study pinned to an old saved version reported "Compilation
error" while every run printed "Saved / Plan drawn / exit 0". `tradingview_bot.py
plan` now sweeps EVERY chart, because one chart's legend says nothing about the other
two, and it waits ~6s per chart because TradingView recompiles asynchronously and a
check 2.5s after saving reads the PREVIOUS compile as clean.

Two failures to name explicitly if you see them:

- **ORPHAN study** — titled with a timestamp, backed by no saved script, so saving can
  never update it and it draws the old panel over the live one. Must be deleted by
  hand; relay the tool's exact instructions.
- **Legend collapsed** — studies cannot be removed programmatically. A `False` from
  `ensure_legend_expanded` is normal, not an error.

## Preconditions for anything that drives the browser

1. Server on :3001
2. Edge on CDP 9222 (`tasks/launch_chrome_tv.bat`)
3. TradingView logged in

`/tv context`, `/tv watch`, `/tv review` and `/tv pine` need none of them.
