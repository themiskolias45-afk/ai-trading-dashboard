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
    title: "CRT (Candle Range Theory) — Gold and SPX",
    status: STATUS.CANDIDATE,
    measuredOn: "2026-08-09",
    evidence: "Walk-forward WITH costs on Yahoo, 5 sequential out-of-sample folds x 3 "
      + "assets: 15 of 15 folds positive gross. THEN re-measured on the instruments the "
      + "engine actually trades (MT5 bars, ~300 D1 / 400 H1): GOLD XAUUSD D1 +0.097R, "
      + "break-even $6.19 (52 trades); SPX SP500 D1 +0.074R, break-even 4.92 pts, and H1 "
      + "+0.156R, break-even 2.27 pts; BTC BTCUSD D1 +0.047R and H1 NEGATIVE.",
    caveat: "The Yahoo proxy OVERSTATED Gold badly — GC=F showed +0.269R and break-even "
      + "$14.10 where real XAUUSD gives +0.097R and $6.19, roughly a third of the edge. "
      + "It also found only 30 patterns to XAUUSD's 52 on the same window, so the two "
      + "instruments genuinely present different structure. Gold still clears a "
      + "$0.20–0.50 spread against a $6.19 break-even, and SPX clears comfortably; BTC "
      + "is dead. The MT5 sample is 1-2 years and UNFOLDED (the bridge caches 300 daily "
      + "bars), windows are matched by bar count not calendar, and slippage beyond "
      + "spread is unmodelled.",
    changesTheAnswer: "More broker history. Raising BAR_COUNT_BY_TIMEFRAME would allow a "
      + "real folded walk-forward on XAUUSD itself — note the candle payload already hit "
      + "a 413 at ~240kb, so that is a deliberate change. Until then the strongest single "
      + "cell is SPX H1 on broker bars (+0.156R, break-even 13.2% of bar range).",
    harness: "node tasks/crt_walkforward.cjs  ·  node tasks/crt_mt5_transfer.cjs  ·  node tasks/crt_as_setup_walkforward.cjs",
    // Added after the setup test. CRT stands up as a pattern and falls over as an
    // engine setup, and those are different claims — keeping only the first would
    // read as an unexploited opportunity when it has in fact been tried.
    asEngineSetup: "REJECTED 2026-08-09. Injected at the end of the setup chain and "
      + "replayed over 5 folds at gate 70: +3 trades for -0.054R, better in 0/5 folds. "
      + "It also is not cleanly additive — 19 CRT trades appeared while the total rose "
      + "by 3, because setting the daily leg to BUY/SELL moves the step out of the "
      + "H4_ONLY cohort and suppresses entries that used to clear the gate. A genuinely "
      + "additive test would need CRT to enter as its own timeframe leg.",
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
    changesTheAnswer: "The per-direction experiment has now RUN and did not support the "
      + "ledger. tasks/minrr_direction_walkforward.cjs, 5 folds at gate 70: the best "
      + "candidate (1.35 long / 1.50 short) shows +0.158R/trade overall but 109% of that "
      + "gain is a SINGLE fold — better in only 3/5, worse in folds 1, 3 and 5. Loosening "
      + "longs further (1.25) is better in just 2/5. Touching shorts alone does nothing. "
      + "Verdict NOT PROVEN; the bar stays at 1.5 both ways. To move it now you would need "
      + "a candidate that improves in most folds without one fold carrying it.",
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
