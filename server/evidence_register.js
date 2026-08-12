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
    measuredOn: "2026-08-12",
    evidence: "NOW SESSION-ALIGNED, and still far too thin to judge. On 13,757 real "
      + "Gold hourly bars (2 years) the detector finds 16 patterns, of which only 3 are "
      + "the textbook ASIA accumulation → LONDON sweep → NEW YORK distribution. The "
      + "most common sequence is ASIA → NEW YORK → NEW YORK (6). An earlier run that "
      + "pooled every shape together reported 33 resolved trades across three assets.",
    caveat: "The block has MOVED and its old reason was stale. The bridge has sent bar "
      + "open times since 2026-08-09; what was actually missing is that detectAMD never "
      + "read them and hardcoded sessionAligned:false, while geometry_measure.cjs threw "
      + "the timestamps away in its own loader. Both fixed 2026-08-12. What blocks AMD "
      + "now is SAMPLE SIZE, not missing data: 16 patterns in two years, 3 of them "
      + "classic, cannot support any claim about edge.",
    changesTheAnswer: "More patterns — which means more history, or a looser window, and "
      + "loosening the window changes what the pattern IS so it would need its own "
      + "control. Measure the classic subset SEPARATELY from the rest: pooling a 19% "
      + "minority with shapes that merely resemble it is what made the earlier number "
      + "uninterpretable.",
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
    // The proposal this settles came from the AI employee, not a human, and it was
    // right about the individual trade while being wrong about the population. Both
    // halves are recorded deliberately: dropping the first would read as the agent
    // being unreliable, and dropping the second would license the change.
    id: "regimeveto",
    title: "Veto RANGE_TRADE_SHORT when regime is RANGING",
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-12",
    evidence: "Proposed by the VPS weekly review of 2026-08-09. Year-split cross-tab of "
      + "the MTF replay, 2022-07 to 2026-07. At conf floor 40 the cell is 23 closed, "
      + "30.4% WR, −0.150R/trade — but only 2023 (n=8) clears the 8-trade-per-year "
      + "floor, and 2022 (+0.353) and 2024 (+0.286) are POSITIVE, so the pooled "
      + "negative is essentially one year. At the live gate (conf ≥ 70) the population "
      + "a veto would actually change is ONE closed trade, in 2022, which WON (+1.56R).",
    caveat: "The review named this exact risk itself — n is thin and short-side bans are "
      + "usually bull-sample bias — so the proposal fails its own stated test. Two things "
      + "still stand and neither licenses the change: it named the trade that closed "
      + "−$99.10 two days before it closed, and the rejection ledger has this setup at "
      + "0W/12L, the only setup on the board with zero wins. It also cited −13.59R over "
      + "24 closed where the MTF replay gives −3.5R over 23 — comparable n, very "
      + "different R — so its headline number came off a different replay path and it "
      + "never named the harness. Per the MTF/single-timeframe split, the "
      + "_replay_engine.cjs population is not the one the live gate trades. Its four "
      + "cited line numbers are all wrong on both boxes (generateSignalMTF is at 1565, "
      + "not 1413), but the script it told you to run, tasks/_regime_xtab.cjs, is REAL "
      + "and lives on the VPS — an earlier note here called it fabricated on the "
      + "strength of a broken directory check.",
    changesTheAnswer: "Sample at the gate. The at-gate population is n=1; a verdict there "
      + "needs enough trades to score more than one year. Re-run the harness as closed "
      + "fills accumulate. A candidate would have to be negative in EVERY scorable year "
      + "at the gate, not merely negative when pooled.",
    harness: "node tasks/regime_xtab.cjs",
    feedsTheGate: false,
  },
  {
    id: "liveconfig",
    title: "Live config expectancy",
    status: STATUS.UNMEASURED,
    measuredOn: "2026-08-12",
    evidence: "Three closed fills in the system's entire life across 154 server "
      + "sessions: −$449.72 (BB_SQUEEZE_WATCH), −$99.10 (RANGE_TRADE_SHORT) and "
      + "+$135.91, gross −$412.91, expectancy −$137.64/trade. Two positions are open. "
      + "Win rate, calibration and per-setup edge still rest on n=3, which is one trade "
      + "per setup — below the 5-trade floor the learning engine itself requires before "
      + "it will act.",
    caveat: "The 2026-07-28 decision to trade a measured-negative edge in order to feed "
      + "the learning engine was deliberate and informed. Two of the three closes only "
      + "arrived because reconciliation was repaired on 2026-08-11; before that they sat "
      + "OPEN indefinitely. The single WIN is not in learning.json at all — its setup "
      + "name was recorded as \"WAIT\", which updateLearning refuses to attribute rather "
      + "than invent a bucket for, so the learning engine's own record reads 0W/2L while "
      + "the journal reads 1W/2L. Any calibration claim must say which of the two it "
      + "means.",
    changesTheAnswer: "Sample. The rejection ledger is the only route that produces it "
      + "without funding the experiment. This claim's numbers must be re-read from "
      + "get_performance whenever it is cited — it has been stale before, stating n=1 "
      + "and 119 sessions long after both had moved.",
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
