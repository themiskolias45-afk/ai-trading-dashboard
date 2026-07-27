Parallel multi-agent analysis of the trading engine. Five analysts read the same measured fact pack simultaneously, a synthesiser merges them, and every proposal that names a tunable setting is put through the evidence gate. Usage: /analysis [fresh|show|facts]

$ARGUMENTS selects the mode. If blank, defaults to `show` when a report under 24h old exists, otherwise `fresh`.

**show** — read the last report, do not re-run:
```
curl -s http://localhost:3001/api/analysis
```

**fresh** — run the full pipeline (takes several minutes, six agents):
```
python parallel_analysis.py --tf D1,H4
```

**facts** — build the fact pack only, no agents, no cost:
```
python parallel_analysis.py --tf D1 --facts-only
```

Then report:

**PARALLEL ANALYSIS — [generatedAt, age]**

Sample: [N replayed trades, win rate, profit factor, expectancy R/trade]

VERDICT: [the synthesiser's one-paragraph verdict]

Then each ranked action:
  #N [action]
     why      : [rationale]
     backed by: [which analysts agreed]
     gate     : [TESTED / NO_IMPROVEMENT / UNMEASURABLE / SKIPPED + detail]

Then blind spots.

Rules when reporting:
  - A `gate: UNMEASURABLE` action is NOT evidence-backed. Say so plainly — it means
    the replay cannot see that setting, so nobody has measured whether it helps.
  - Never present an action with `gate: NO_IMPROVEMENT` as a recommendation. It was
    tested and it lost.
  - If `replayErrors` is non-empty, say which symbol/timeframe is missing before
    reporting any conclusion — a verdict drawn from two assets instead of three is
    a different verdict.
  - If any analyst returned `_error`, name it. Four analysts is not five.
  - Ask before applying any action. Nothing here auto-applies.
