# CRT as an additive confidence contributor — scope

**Status: SCOPED, NOT BUILT. No engine file changes yet.**
Written 2026-08-19. Approved shape: *measured first, wired second, never a veto.*

Contract for the CRT claim in `server/evidence_register.js`. Read this before touching
`server/index.js`, `server/structure.js` or `server/sizing.js` for CRT.

---

## 1. Why CRT and not something else

CRT is the only pattern in this project that has produced positive out-of-sample
evidence and is currently wired to nothing. `detectCRT` has **no caller anywhere in
`server/index.js`** — verified 2026-08-19 by grep; its only callers are
`server/structure.test.js` and `tasks/crt_walkforward.cjs`. The live engine does not
compute it at all, so "wiring it" is a build, not a toggle.

It also fits the constraint that matters here: a contributor **adds** confidence, so it
can only ever cause MORE signals to fire, never fewer. Nothing in this design blocks a
trade, removes a trade, filters a setup, or deletes anything.

## 2. The measurement gap — the whole reason for Phase 1

Every CRT number on record measures CRT as a **standalone entry signal**: enter on the
distribution candle, hold N bars, exit. That is a different question from the one wiring
asks, which is:

> When the engine has ALREADY produced a setup, does a same-direction CRT nearby
> predict a better outcome than its absence?

Nobody has counted that joint population. It may be small: the engine fires ~96/year
live, and CRT found 52 D1 patterns in ~300 XAUUSD bars. **The overlap could be too thin
to judge, and that is a legitimate outcome of Phase 1.**

Two further reasons the existing numbers cannot be carried over as-is:

- **Instrument.** The folded 15/15 result is on **Yahoo proxies**. `GC=F` found 30
  patterns where broker `XAUUSD` found 52 on the same window — the detector sees
  genuinely different structure across the basis. Any Gold figure from `GC=F` describes
  a different instrument. Phase 1 runs on broker bars only.
- **Folds.** The broker-bar transfer test was **unfolded**.

## 3. What is actually available now (verified, not remembered)

`GET /api/mt5/candles/raw` on 2026-08-19, all three assets, **with `times`**:

| timeframe | bars | span | folded walk-forward possible? |
|---|---|---|---|
| D1 | **600** | ~2.4 years | **yes** — 3 sequential folds |
| H4 | 400 | ~9 months | marginal |
| H1 | 400 | ~2.5 months | **no** |

`BAR_COUNT_BY_TIMEFRAME` at `mt5_bridge.py:784` is already `{"d1": 600, "h4": 400,
"h1": 400}`. The note in memory saying the bridge caches 300 daily bars is **stale** —
D1 needs no bridge change at all.

**The one blocker is H1**, and H1 is where the strongest cell lives (SPX H1 +0.156R on
broker bars). Raising `h1` costs a bridge edit, a bridge restart that needs elevation on
the laptop, and re-tests the payload size that previously 413'd at ~240kb. That is a
deliberate change and a separate decision — see section 7.

## 4. The cells. Per-cell, never global

Wire only what measured positive **on broker bars**. BTC is dead and stays out: 0/5 folds
positive at a 10% cost, break-even $29.91 = 0.047% of price, inside ordinary crypto CFD
spreads, against a ~1700pt BTCUSD spread already on record.

| cell | broker-bar standalone | Phase 1 verdict |
|---|---|---|
| GOLD D1 | +0.097R, break-even $6.19 vs a $0.20-0.50 spread | measure |
| SPX D1 | +0.074R, break-even 4.92 pts | measure |
| SPX H1 | **+0.156R** — strongest cell in the project | measure, blocked on section 7 |
| BTC any | negative / inside spread | **excluded, do not measure** |
| GOLD H1/H4 | unmeasured | out of scope for now |

## 5. Design constraints for the wiring (Phase 2)

Non-negotiable, each because of a specific trap already in this codebase.

1. **Additive only.** The contribution is `confidence = Math.min(100, confidence + N)`.
   No negative branch, no veto, no cohort floor, no minimum. **CRT absent, CRT
   disagreeing, and CRT unavailable must all produce byte-identical behaviour to today.**
   The regression test is exactly that: same inputs with the detector stubbed to return
   nothing must reproduce today's confidence for every asset.
2. **It must not smuggle a size increase.** Confidence is dual-purpose — `server/sizing.js`
   scales risk at **>=75 -> 1.25x** and **>=90 -> 1.5x**. A contributor validated at
   constant R that lifts a setup from 72 to 77 has silently changed position size to a
   level nothing measured. Same trap the Gold neutral-H4 cohort carries an explicit clamp
   for (`SIZING_BOOST_MIN_CONFIDENCE - 1`, index.js ~1955). **The CRT boost is clamped
   below the sizing tier** until a cell has live closed trades of its own. Currently
   inert under `fixedLotSize: 0.01`, but that is a property of the config, not of the
   code, and the sizing flip is the next planned lever.
3. **Direction must match.** A `bullish` CRT boosts a BUY only; `bearish` boosts a SELL
   only. `detectCRT` already returns `direction`.
4. **Freshness is a measured parameter, not a guess.** A confirmed CRT 40 bars back says
   nothing about today. `barsAgo` max is swept in Phase 1 and the value that survives the
   folds is the one shipped. `confirmed: true` is required (the detector's default).
5. **Same timeframe as the signal.** Read CRT off `signalTf`'s timeframe — the principle
   the entry, stop and target already follow. No cross-timeframe borrowing.
6. **Logged as its own reason.** `daily.reasons.push()` naming the direction, `barsAgo`
   and the points added, so the journal can attribute outcomes to it later.

## 6. Phase 1 — the harness (read-only, changes nothing live)

New file `tasks/crt_confluence.cjs`. Nothing it does can affect trading.

1. Pull broker bars from `GET /api/mt5/candles/raw` (local-only route, already exists).
2. Replay the engine's own setup generation across the series — reuse the
   `_replay_mtf.cjs` sandbox pattern, and **stub helpers exactly as that harness does**
   or the run silently drops assets and reports success.
3. For every engine setup, tag whether a `confirmed` same-direction CRT exists within
   `barsAgo <= K`, sweeping K.
4. Compare **R/trade of the CRT-agreeing subset against the CRT-absent subset**, per
   cell, with the same `costR = costPrice / riskDistance` sweep as `crt_walkforward.cjs`
   — CRT's stop sits at the sweep extreme, so a flat-R cost model flatters it badly.
5. Sequential disjoint folds. D1: 3 folds on 600 bars.

**Kill criteria, stated before the run so the result cannot be rationalised afterwards:**

- **Sample floor: >=30 co-occurrences per cell.** Below that the cell reports
  TOO FEW TO JUDGE and is not wired. No pooling across assets to reach it —
  cross-instrument pooling already produced a sign error in this project once.
- **Worst-fold standard.** The CRT-agreeing subset must beat the CRT-absent subset in
  **most folds** AND its **worst fold** must be better than the CRT-absent worst fold.
  Same bar that keeps the gate at 70 and retired 65 as DEGRADED. A better mean is not
  sufficient.
- A cell that fails is simply not wired. The detector stays observability-only there.

## 7. The open decision

**SPX H1 is the strongest cell and cannot be folded on 400 bars.** Reaching it needs
`BAR_COUNT_BY_TIMEFRAME["h1"]` raised in `mt5_bridge.py`, which means a bridge restart —
elevation on the laptop, and a re-test of the payload that previously 413'd at ~240kb.

Gold D1 and SPX D1 can be measured **today, with no change to anything**.

## 8. What this explicitly does not do

No gate change. No threshold change. No setup suppressed. No file deleted. No guard
added. Rejection-ledger semantics unchanged. If Phase 1 says the confluence is not there,
CRT stays exactly where it is — context only, alongside FVG — and nothing in the engine
moves.
