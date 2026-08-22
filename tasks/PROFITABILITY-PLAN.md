# How this system becomes profitable — the plan, and what it rests on

Written 2026-08-22. Every number here was measured this session on this machine, and each
claim names the run that produced it. Where two measurements disagree, both are shown.

**Nothing in this document changes a setting.** It is a plan, and each step names the
evidence that would justify acting and the observation that would stop it.

---

## 0. The finding that outranks everything else on this page

Two ways of measuring "edge at the live gate" **reverse which instrument carries the
system**:

| instrument | floor-40 replay, filtered to conf ≥ 70 | true gate-70 replay |
|------------|----------------------------------------|---------------------|
| XAUUSD | 130 closed, **+28.53R** | 167 closed, **+10.73R** |
| BTCUSD | 59 closed, **+6.16R** | 111 closed, **+33.67R** |
| SP500 | 13 closed, −10.65R | 30 closed, −11.20R |

**Why they differ.** The replay holds one position at a time. With the confidence floor at
40 the engine takes low-confidence trades, and an open low-confidence trade **blocks a
higher-confidence setup that arrives while it runs**. Filter that run to conf ≥ 70
afterwards and you are scoring the survivors of a competition the live engine never holds
— live, the sub-70 setups never fire, so the slot is free.

**Which is right depends on the question.** For SWEEPING a threshold you need the
sub-gate candidates visible, so floor-40 is correct. For judging **what the live engine
earns**, the gate-70 replay is the only faithful one.

**Why it outranks the rest of this page:** `per_instrument_edge.cjs`, the cohort tables and
every per-asset conclusion in this project use the floor-40-then-filter method. So the
sentence "Gold is the profit engine, contributing 119% of pooled R" — printed by that
harness today — **may name the wrong asset.**

**Do not act on either column yet.** Neither has been fold-scored the same way, and both
are small over four years. What to do is in step 1.

---

## 1. First: settle which population the evidence should be built on

**The work:** score both populations identically — same folds, same cost, same R cap,
worst-fold verdict — for all three instruments. Then state, once, which method this
project uses for live-edge claims and make the harnesses agree.

**Why first:** every later step on this page reads a per-asset number. If the population
is wrong, the plan is confidently wrong, and this project has already been burned exactly
this way — a harness measuring a different population than the one that trades.

**What would end it:** a table where both methods are fold-scored and the disagreement is
either resolved or bounded. If they still disagree, the gate-70 population wins for
live-edge claims, and the floor-40 population is reserved for sweeps.

**What must not happen:** re-running the sweeps at gate 70 "because it is more realistic".
That would hide every sub-gate candidate and make threshold search impossible.

---

## 2. The one per-asset conclusion that survives both methods

**SP500 loses money under both.** −10.65R over 13 closed one way, −11.20R over 30 the
other. It is the only instrument negative in both columns, and its single scored fold is
−1.050 with a 7.7% win rate.

It is also **TOO FEW TO JUDGE** by the harness's own floor, and the sample is small enough
that this could still be noise. Memory already records that SPX has exactly one reachable
cohort (Daily+H4-agree, −0.819R in replay) and that it fired live once, on 2026-08-18.

**The measurement that would settle it:** SPX-only, both populations, five folds, worst
fold, per-asset cost. If it is negative in most folds under both, the candidate action is
to raise SPX's bar or drop it — routed through the searcher's discipline (win every cut,
clear the standard-error bar), never applied directly.

**What would stop it:** SPX turning positive once the population question in step 1 is
settled, or the live SPX fill resolving profitably and enough others following it.

---

## 3. The binding constraint is sample size, and nothing on this page changes that

Live fills arrive about **one every 3.8 days** — roughly 96/year against ~218/year in
replay. Five closed trades exist. **Every conclusion above is replay evidence**, and the
gap between replay and live is not yet measurable at this sample.

So the honest ordering is:

1. Protect the accumulation. Nothing may slow the journal, the shadow ledger or the
   calibration record.
2. Improve the MEASUREMENT while the sample grows — that is what steps 1 and 2 are.
3. Change what trades only when a measurement survives every cut.

**The rejection ledger is the one way to manufacture evidence without waiting**, because
every gate rejection is a fully priced paper trade. It is a screening signal, not realised
P&L, and where it contradicts a walk-forward the walk-forward wins.

---

## 4. What is currently stopping trades, measured

**The RSI ceiling, overwhelmingly.** Across three daily checks: 10/10, 12/12 and 148/148
near-misses were `RSI_ABOVE_CEILING` — 170 of 170. One missed by **0.0 points** (BTCUSD H4
at exactly 72.0 against `rsi < 72`).

And yet **the ceiling must not move**. Three independent cuts — equal-count folds,
equal-time folds, per-asset cost — all return INCONCLUSIVE. Four candidates beat the
baseline's worst fold under every cut and **none clears the standard-error bar of 0.103**.

This is the most important discipline on the page: *the thing blocking the most trades is
not automatically the thing to change.* Loosening the ceiling always admits more setups;
whether they pay is a separate question, and three measurements decline to answer it.

**What would change it:** live fills above the ceiling, not a fourth re-slicing of the same
2022–2026 bars.

---

## 5. Costs are conservative, and unevenly so

Flat `0.05R` per trade against measured spread cost: Gold 5.8x, BTC 3.8x, SPX 10.7x.

**Nothing here is flattered by it** — the flat basis over-charges all three. What it
distorts is the RELATIVE penalty, biasing cross-asset comparisons **against SPX**, which
matters directly for step 2: part of SPX's poor showing is a cost basis that charges it ten
times its spread.

Spread is a FLOOR on cost. Commission, swap and slippage are unmeasured, which is why the
flat basis stays the default headline.

---

## 6. The machinery that keeps this honest, already running

- **`SmartEntryStrategySearch`** — VPS daily 05:00. Proposes, cannot write. A challenger
  must win every cut and beat the incumbent's standard error. First round: 4 candidates
  won all three cuts, **0 promotable**.
- **`SmartEntryAutoTune`** — now propose-only. It could previously write a live threshold
  and restart the server via a task that cannot start headless.
- **`backtest_health.cjs`** — 13 harnesses x 10 safeguards. R:R cap now 9/9. Open:
  worst-fold ranking 10 of 11.
- **Bar staleness** — the cache is 28–30 days old and nothing schedules a refresh. The
  searcher now says so on every run rather than re-testing identical data silently.

---

## The order of work

1. **Settle the population question** (step 1). Everything per-asset depends on it.
2. **Re-run per-instrument edge under the settled method**, fold-scored, both cost bases.
3. **Decide SPX** on that evidence, through the searcher, never by hand.
4. **Refresh the bar cache** so the daily search sees new data — timed when no position is
   open, because the exporter opens a second MT5 client.
5. **Let it run.** The sample is the constraint; time is the only thing that fixes it.

**What "profitable" honestly requires:** a live sample large enough to confirm the replay
edge, on a configuration whose measurement method is settled. Today the system has 5 closed
trades and two credible per-asset stories that disagree. Step 1 costs one afternoon and
determines whether the next year of decisions points at the right instrument.
