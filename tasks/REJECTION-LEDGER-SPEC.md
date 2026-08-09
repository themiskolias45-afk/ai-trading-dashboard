# Universal Rejection Ledger — shared contract

**Status:** write + score + shadow-learn are BUILT and run nightly via
`tasks/auto_daily.bat` (lines 45-46). The verdict layer landed 2026-08-09.
Read this before touching any part of it.

## Where it stands (2026-08-09)

| stage | file | state |
|---|---|---|
| write | `server/rejection_log.js`, `POST /api/rejections` | live, 4 of 10 gates producing rows |
| count | `GET /api/gate-health` | live — says a gate is FIRING |
| score | `tasks/score_rr_rejections.py` → `rejections_scored.jsonl` | live, nightly, 119 rows |
| shadow | `tasks/learning_from_rejections.py` | live, nightly |
| **verdict** | `server/rejection_evidence.js`, `GET /api/rejection-evidence`, MCP `get_rejection_evidence` | **live** — says whether it SHOULD have |

The verdict layer existed as a question in section 0 of this document for three
days while the evidence to answer it sat on disk. Nothing computed it.

**First readings**, 30 resolved episodes:

- `MIN_RR` — 22 resolved, 82% would have won, **+7.14R**: COSTING MONEY.
  `BUY_OVERSOLD` 8W/0L, `RANGE_TRADE_LONG` 10W/3L.
- `CONFIDENCE` — 8 resolved, 50%, +2.81R: COSTING MONEY.
- `STALE_SOURCE`, `DUPLICATE` — 0 resolved, no claim.

**This contradicts the walk-forward** (`tasks/param_walkforward.cjs`: lowering
MIN_RR to 1.35 buys 3 trades in 4 years and costs 6.6R). The ledger is 22 recent
episodes in one regime, on paper entries with no spread; the sweep is 4 years
out-of-sample. **The walk-forward wins.** The contradiction is recorded, not
resolved, and neither has moved a setting.

### Still missing

- **6 of 10 gates produce no rows.** `ENTRY_RSI` and `COHORT_FLOOR` are engine-side
  and instrumented but show 0 kills / 0 passes in `gate-health` — verify they are
  reachable at all. `SPREAD`, `AI_FILTER`, `NEWS_BLACKOUT`, `MAX_POSITIONS` are
  bridge-side (owner B) and appear unwired. Section 5 names `COHORT_FLOOR` as the
  single highest-value consumer of this ledger and it is currently silent.
- 86 of 119 rows are `PENDING`; they resolve as their horizon elapses on the
  nightly run.
**Principle:** every gate that kills a setup leaves evidence. Today one of nine does.

A rejection is a fully specified paper trade — entry, stop and target are all computed
before any gate fires. Recording them turns each rejection into a case that can be
scored against what price actually did, at zero risk. The binding constraint on this
system is sample size (2 lifetime trades); this is the only route that manufactures
evidence without funding the experiment.

**This is observability. It must never change what trades.** No gate logic moves, no
threshold moves, no signal is admitted or suppressed as a result of this work. A
logging failure must never reach the trading path — swallow it into a console line, as
`logRrRejection` already does.

---

## 1. The file

`tasks/rejections.jsonl` — append-only, one JSON object per line.

`tasks/rr_rejected.jsonl` is **frozen, not migrated**. It holds real evidence (11 rows
on the laptop, 8 on the VPS) written under the old schema. Never rewrite or delete it;
the scorer reads both and normalises. New MIN_RR rejections go to the new file only.

## 2. The row

Every row carries these fields. Use `null`, never omit, so a missing value is a real
bucket downstream instead of vanishing.

```json
{
  "ts": "2026-08-06T12:44:07.117Z",
  "gate": "MIN_RR",
  "side": "engine",
  "ticker": "GC=F",
  "label": "Gold/XAUUSD",
  "dataSource": "mt5",
  "sourceSymbol": "XAUUSD",
  "timeframe": "D1",
  "setup": "RANGE_TRADE_SHORT",
  "direction": "SELL",
  "entry": 4266.62,
  "stop": 4397.55,
  "target": 4075.53,
  "rr": 1.459,
  "confidence": 68,
  "strength": "MODERATE",
  "threshold": 1.5,
  "actual": 1.459,
  "trend": "MIXED",
  "rsi": 69.3,
  "account": null
}
```

- `gate` — one of `MIN_RR`, `ENTRY_RSI`, `CONFIDENCE`, `COHORT_FLOOR`, `SPREAD`,
  `AI_FILTER`, `NEWS_BLACKOUT`, `STALE_SOURCE`, `DUPLICATE`, `MAX_POSITIONS`.
- `side` — `"engine"` or `"bridge"`.
- `sourceSymbol` — the instrument the levels were priced on. **Never use `ticker` for
  scoring.** `ticker` is always the Yahoo symbol regardless of which feed supplied the
  bars, and GC=F futures sat ~$60 from XAUUSD spot when the first rows were written.
  A row without `sourceSymbol` is unscorable and must be recorded as such, not guessed.
- `timeframe` — `D1`/`H4`/`H1`. A daily setup and an H1 setup have different hold times,
  so without it "would this have won" is unanswerable.
- `threshold` / `actual` — the number that killed it and the number that failed, so a
  sweep can ask "what if the bar had been X" without re-deriving anything.
- `account` — bridge rows only; `null` on engine rows.

## 3. Two rules that decide whether the dataset is worth anything

**3.1 Log only a setup that FORMED and was then killed.** A step where no setup formed
is not a rejection, it is a non-event. XAUUSD alone has 3799 `BOTH_WAIT` steps in a
5-year replay; logging those would bury the signal and answer nothing. Concretely: there
must be a real `setup` name and a real `entry`/`stop`/`target` triple at the moment the
gate fires.

**3.2 Dedupe per `gate` + `sourceSymbol` + `timeframe` on the level signature.** Gates
re-fire on every refresh and once per timeframe. Today's MIN_RR log wrote 7 near-
identical rows for one drifting Gold short in four hours. Without deduping, the
confidence gate alone would write thousands of rows a day. Signature is
`setup|direction|entry|stop|target`; suppress a row whose signature equals the last one
recorded for that scope. Keep the map in memory — it is a volume control, not a
correctness mechanism.

## 4. Gate inventory — the nine call sites

| gate | file:line (2026-08-06) | side | owner |
|---|---|---|---|
| `MIN_RR` | `server/index.js:1191` | engine | A |
| `ENTRY_RSI` | `server/index.js:1211` | engine | A |
| `CONFIDENCE` | `server/index.js:1459` | engine | A |
| `COHORT_FLOOR` | `server/index.js:1583` | engine | A |
| `SPREAD` | `mt5_bridge.py:853` | bridge | B |
| `AI_FILTER` | `mt5_bridge.py:1192` | bridge | B |
| `NEWS_BLACKOUT` | `mt5_bridge.py:1023` | bridge | B |
| `STALE_SOURCE` | `mt5_bridge.py:1017` | bridge | B |
| `DUPLICATE` / `MAX_POSITIONS` | `mt5_bridge.py` | bridge | B |

`CONFIDENCE` and `COHORT_FLOOR` are the same `finalSignal = ... : "WAIT"` decision at
`index.js:1583`. Record them as **separate gates**: `COHORT_FLOOR` when
`effectiveThreshold > confidenceThreshold` and the confidence would have cleared the
global gate, `CONFIDENCE` otherwise. That distinction is the whole point — it is
precisely what hid Gold's dead cohort.

## 5. Pass counters — `gateStats`

Rejections alone cannot tell you a gate is dead; you need the denominator. The engine
keeps an in-memory counter per gate of `killed` and `passed`, exposed read-only at
`GET /api/gate-health` and reset on restart (state is derivable from the ledger, so
this is a convenience, not a source of truth).

**A gate with a healthy kill count and ZERO passes is the alarm.** Gold's
`DAILY_ONLY_H4_NEUTRAL` cohort was capped at confidence 74 by
`SIZING_BOOST_MIN_CONFIDENCE - 1` while its floor demanded 75 — 1131 steps, 0 passes,
for months, with nothing reporting it. That detector is the single highest-value
consumer of this ledger.

## 6. The endpoint — `POST /api/rejections`

For bridge-side rows. Same protection as `/api/mt5/candles`: `requireLocalOnly`, since
the bridge always runs on the same machine as the server. Accepts one row or an array.
Validates `gate` against the enum and drops unknown gates with a warning rather than
writing junk. Returns `{ ok: true, written: n }`.

## 7. The replay sandbox

`tasks/_replay_mtf.cjs` extracts `generateSignal` into a bare `vm` sandbox. **Any helper
the engine calls must be stubbed there or the step throws, the catch swallows it, and
the cohort silently disappears from every measurement.** This has already happened
twice — `SIZING_BOOST_MIN_CONFIDENCE` (1131 Gold steps) and `logRrRejection` (1006).
Stub the new logger to a no-op; it must never append synthetic replay rows to the live
evidence file. Verify with:

```
node tasks/_replay_mtf.cjs . XAUUSD GC=F 40 2>&1 >/dev/null   # engineThrows must be 0
```

## 8. Definition of done

- `node --check` on every JS file, `python -m py_compile` on every Python file
- `engineThrows: 0` in the replay census
- A real row lands in `tasks/rejections.jsonl` for at least one gate, verified live
- `tasks/rr_rejected.jsonl` is byte-identical to before
- No change to which signals fire — compare `/api/signals` before and after
