'use strict';
/**
 * What this system actually KNOWS, versus what it merely assumes.
 *
 * Every measured claim in this project has been living in commit messages and
 * vault notes, which means the dashboard could show a number without ever showing
 * whether that number had been tested. FVG shipped to the Overview and sat there
 * looking tradeable for hours before anyone measured it; it turned out to be worse
 * than random. The register exists so that never happens silently again.
 *
 * A claim on this list carries its verdict, the evidence behind it, the date, and
 * — the part that matters most — WHAT WOULD CHANGE THE ANSWER. A measurement with
 * no stated falsifier is an opinion with a number attached.
 *
 * CURATED, NOT COMPUTED. These are human-reviewed conclusions from harness runs.
 * The live half of the evidence board (per-gate verdicts) comes from
 * rejection_evidence.js and updates itself. Keeping them separate is deliberate:
 * a curated claim that silently changed would be worse than no claim.
 *
 * RULE: nothing in this file feeds a gate, a threshold, confidence or sizing. It
 * is a reading surface.
 */

const STATUS = {
  MEASURED_NO_EDGE: "MEASURED — NO EDGE",
  CANDIDATE:        "CANDIDATE — NEEDS WALK-FORWARD",
  ROBUST:           "MEASURED — ROBUST",
  UNMEASURED:       "UNMEASURED",
  BLOCKED:          "BLOCKED — CANNOT MEASURE YET",
  CONTRADICTED:     "CONTRADICTED — TWO SOURCES DISAGREE",
};

// Ordered most-actionable first; the board renders in this order.
const CLAIMS = [
  {
    id: "crt",
    title: "CRT (Candle Range Theory)",
    status: STATUS.CANDIDATE,
    measuredOn: "2026-08-09",
    evidence: "Ahead of a matched control in all 6 asset/timeframe cells. Daily 10y: "
      + "973 trades, +0.084R vs control −0.110R (+0.194R). Hourly 730d: 5840 trades, "
      + "+0.089R vs control −0.074R (+0.163R).",
    caveat: "Absolute expectancy is only +0.089R/trade while spread+commission is "
      + "plausibly 0.05–0.15R, so costs alone could erase it. Profile is 73% wins at "
      + "R<1 — the shape that dies from a few oversized losses.",
    changesTheAnswer: "A walk-forward WITH costs modelled. If expectancy after costs "
      + "is not clearly positive out-of-sample, it stays off.",
    harness: "node tasks/geometry_measure.cjs [--interval 1h]",
    feedsTheGate: false,
  },
  {
    id: "fvg",
    title: "FVG (Fair Value Gap) as support/resistance",
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-09",
    evidence: "~6,800 samples. Daily 10y: 43.1% win, −0.137R vs control 50.0%, "
      + "−0.001R — 6.9pp WORSE than random. Hourly 730d: no difference. Worst cell "
      + "Gold daily at −0.234R against control.",
    caveat: "One positive cell (Gold hourly +0.151R) out of six reads as "
      + "multiple-comparisons noise, not a finding.",
    changesTheAnswer: "Nothing currently proposed. A different USE of the zones — as "
      + "targets rather than reaction levels — is a separate untested claim.",
    harness: "node tasks/geometry_measure.cjs",
    feedsTheGate: false,
  },
  {
    id: "amd",
    title: "AMD (Accumulation / Manipulation / Distribution)",
    status: STATUS.BLOCKED,
    measuredOn: "2026-08-09",
    evidence: "33 resolved trades pooled across three assets even on hourly bars — "
      + "far below any threshold for a claim.",
    caveat: "mt5_bridge.py `_rates_to_bars` sends no timestamps, so AMD is detected "
      + "on a bar WINDOW and carries sessionAligned:false. It has AMD's shape but is "
      + "not a verified Asia-accumulation / London-sweep sequence.",
    changesTheAnswer: "Add `times` to the bridge bar payload, then re-measure with "
      + "real session boundaries. Note the payload already hit a 413 at ~240kb once.",
    harness: "node tasks/geometry_measure.cjs --interval 1h",
    feedsTheGate: false,
  },
  {
    id: "gate70",
    title: "Confidence gate = 70",
    status: STATUS.ROBUST,
    measuredOn: "2026-08-02",
    evidence: "Positive in 5 of 5 out-of-sample walk-forward folds. 65 is 3/5; "
      + "85 is negative in 4 of 4.",
    caveat: "Gold's squeeze cohort is pinned to exactly 70 "
      + "(GOLD_SQUEEZE_MODERATE_CONFIDENCE). Raise the gate above 70 and that cohort "
      + "silently stops firing.",
    changesTheAnswer: "Re-run run_walkforward (MCP) or node tasks/mtf_walkforward.cjs. "
      + "Read the log timestamps — that file also holds a superseded pre-b55b5f5 run.",
    feedsTheGate: true,
  },
  {
    id: "minrr",
    title: "MIN_RR = 1.5",
    status: STATUS.CONTRADICTED,
    measuredOn: "2026-08-09",
    evidence: "Walk-forward: lowering to 1.35 buys 3 trades in 4 years and costs 6.6R. "
      + "Rejection ledger (VPS, 86 resolved): rejections would have returned +22.47R, "
      + "78% would have won.",
    caveat: "The two disagree. The ledger is recent episodes in one regime on PAPER "
      + "entries with no spread, slippage or partial fills, on a fixed horizon; the "
      + "sweep is 4 years out-of-sample. THE WALK-FORWARD WINS. Neither has moved the "
      + "setting. The ledger's real signal is a DIRECTION SPLIT: RANGE_TRADE_LONG "
      + "59W/11L and BUY_OVERSOLD 8W/0L, but RANGE_TRADE_SHORT 0W/8L.",
    changesTheAnswer: "A per-direction or per-setup experiment, never a global MIN_RR "
      + "move — a blanket change would take the losing shorts along with the winning longs.",
    feedsTheGate: true,
  },
  {
    id: "liveconfig",
    title: "Live config expectancy",
    status: STATUS.UNMEASURED,
    measuredOn: "2026-07-28",
    evidence: "One closed fill in the system's entire life (−$449.72, BB_SQUEEZE_WATCH) "
      + "across 119 sessions. Win rate, calibration and per-setup edge all rest on n=1.",
    caveat: "The 2026-07-28 decision to trade a measured-negative edge in order to feed "
      + "the learning engine was deliberate and informed. It has produced one trade — "
      + "the sample it was meant to generate has not arrived.",
    changesTheAnswer: "Sample. The rejection ledger is the only route that produces it "
      + "without funding the experiment.",
    feedsTheGate: true,
  },
];

function getRegister() {
  return {
    claims: CLAIMS,
    counts: CLAIMS.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {}),
    curated: true,
    note: "Human-reviewed conclusions from harness runs. The live per-gate verdicts on "
      + "this board come from the rejection ledger and update themselves; these do not.",
  };
}

module.exports = { getRegister, CLAIMS, STATUS };
