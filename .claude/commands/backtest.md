Run a proper walk-forward backtest on SmartEntry Pro. Usage: /backtest [asset] [--threshold N]

$ARGUMENTS: optional asset (BTC|GOLD|SPX) and optional confidence threshold override.

This runs a real 5-fold out-of-sample walk-forward test — not a simple replay.
~90 seconds. Do not cancel early.

═══ STEP 1 — PRE-CHECK ═══
  mcp__smartentry__get_strategy_settings → get current confidenceThreshold (live gate)
  mcp__smartentry__get_signals → get current confidence per asset
  mcp__smartentry__get_performance → baseline live WR to compare against backtest

═══ STEP 2 — RUN WALK-FORWARD ═══
  Call: mcp__smartentry__run_walkforward
  This runs 5 out-of-sample folds across the full history.
  Check result.warning — if "DEGRADED", the table is incomplete (say so in report).
  Read result carefully: per-fold WR, overall WR, R-multiple per fold.

  If $ARGUMENTS includes a threshold (e.g. --threshold 68):
    Note the threshold being tested vs current live gate.
    A challenger must beat the CURRENT gate's WORST FOLD to earn a change — not just the mean.

═══ STEP 3 — ANALYSE RESULTS ═══
  For each fold: note WR, R-multiple, trade count
  Identify: best fold, worst fold, is it consistent or volatile?
  Compare to live performance (from Step 1).

  Flag IMPLEMENTATION DRIFT if: live WR is > 10% below backtest WR.
  Flag OVERFITTING RISK if: fold-to-fold WR varies > 20%.

═══ STEP 4 — THRESHOLD COMPARISON ═══
  Current gate: [confidenceThreshold from settings]
  Backtest at current gate: [results]

  If testing a challenger threshold (--threshold N):
    Compare challenger's WORST FOLD vs current gate's WORST FOLD.
    Challenger wins ONLY if its worst fold beats current gate's worst fold.
    "Better mean but worse floor" = REJECT.

═══ REPORT FORMAT ═══
WALK-FORWARD BACKTEST — [date] — threshold [N]%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FOLD RESULTS:
  Fold 1: [period] | WR [X]% | [Y] trades | R: [Z]
  Fold 2: ...
  Fold 3: ...
  Fold 4: ...
  Fold 5: ...

SUMMARY:
  Overall WR: [X]% | Avg R: [X] | Total trades: [X]
  Best fold:  Fold [N] — [X]%
  Worst fold: Fold [N] — [X]%  ← this is the real risk metric
  Consistency: [STABLE / VOLATILE — fold spread > 20%]

LIVE vs BACKTEST:
  Live WR: [X]% | Backtest WR: [X]% | Drift: [X]%
  [ALIGNED / IMPLEMENTATION DRIFT — investigate]

VERDICT:
  Current gate ([N]%): [EARNS ITS KEEP / COSTING MONEY / TOO FEW TO JUDGE]
  [If challenger tested]: Challenger ([N]%): [BETTER / WORSE / SAME] — worst fold [X]% vs [Y]%
  Recommendation: [KEEP / RAISE TO N / LOWER TO N] — one sentence with evidence

After report: "Run challenger at a different threshold? (Y/N)"

═══ STEP 5 — EVIDENCE REGISTER UPDATE ═══
  Every backtest result is a measured claim. Generate a template block for
  server/evidence_register.js so the finding does not live only in chat.

  Determine STATUS:
    - Worst fold positive AND ≥4/5 folds positive → STATUS.ROBUST
    - Worst fold positive but only 3/5 positive, OR fold spread > 20% → STATUS.INCONCLUSIVE
    - Overall negative or worst fold clearly negative → STATUS.MEASURED_NO_EDGE
    - DEGRADED warning → STATUS.BLOCKED

  Print the template:
  ─────────────────────────────────────────
  {
    id: "[gate-or-threshold]-[YYYY-MM-DD]",
    title: "[what was measured in one line]",
    status: STATUS.[ROBUST|INCONCLUSIVE|MEASURED_NO_EDGE|BLOCKED],
    measuredOn: "[YYYY-MM-DD]",
    evidence: "[fold summary: worst fold X%, overall WR Y%, Z trades, N/5 folds positive]",
    caveat: "[what the test cannot prove — stubs, sample size, cost assumption]",
    whatWouldChangeThis: "[the specific measurement that would move this status]",
  }
  ─────────────────────────────────────────
  Ask: "Append this claim to server/evidence_register.js? (Y/N)"
  If Y:
    Read server/evidence_register.js — find the closing `];` of the CLAIMS array.
    Insert the new block before it.
    Run: node --check server/evidence_register.js → exit 1 if fails, do not commit.
    Commit: git add server/evidence_register.js && git commit -m "evidence: add [id] claim"
  If N: "Template printed above — paste into evidence_register.js when ready."
