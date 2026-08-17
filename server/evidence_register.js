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
    // First on the board deliberately: it governs how every OTHER ledger number here
    // should be read. Anyone acting on a netR figure without this claim in front of
    // them is acting on one row.
    id: "ledgeroutlier",
    title: "The rejection ledger was positive only because of collapsed-stop artifacts",
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-17",
    evidence: "Capping implied R:R at 10 (MAX_PLAUSIBLE_RR) turned the ledger's sign over "
      + "on BOTH boxes. VPS total netR +260.80R → −40.91R across 476 resolved; laptop "
      + "+10.26R → −12.17R across 162. Seven VPS rows and two laptop rows exceeded the "
      + "cap. The worst was SELL_BOUNCE BTCUSD D1 at implied R:R 298.6 — entry 64400.75, "
      + "stop 64404.96, a $4.21 stop on Bitcoin, 0.0065% of price and inside the spread — "
      + "carrying +298.56R on its own against a whole-ledger total of +279.05R.",
    caveat: "The correction settled a gate verdict, and it settled it the other way. The "
      + "VPS read CONFIDENCE at +232.71R over 69 resolved with 4% would-have-won and a "
      + "verdict of COSTING MONEY — 4% winners cannot produce a positive net. It now "
      + "reads −65.85R at 3% and EARNING ITS KEEP, which is arithmetically coherent. That "
      + "is the gate the whole funnel dies at, so it was the one most likely to be "
      + "loosened on the strength of one bad stop distance. Same class as the recovered "
      + "VPS analyst finding whose '+140R edge' was 59% four rr-artifact trades: the "
      + "SECOND time an R outlier has driven a headline number here. MIN_RR is unaffected "
      + "in kind — still +17.46R at 66% on the VPS, still CONTRADICTED by the "
      + "walk-forward, and the walk-forward still wins.",
    changesTheAnswer: "The cap is on implied R:R, not on a fraction of price, because R:R "
      + "is scale-free — one number serves BTCUSD at 64,000, XAUUSD at 4,400 and SP500 at "
      + "7,800. That choice was load-bearing: two caught rows had stops at 0.168% and "
      + "0.194% of price, comfortably ABOVE the tightest legitimate row, so a price-"
      + "fraction floor would have missed them while catching the wrong things. 10 comes "
      + "from measured output — the engine builds targets at about 2.5x risk, the largest "
      + "plannedRr in the journal is 6.57, and the laptop ledger has an empty gap between "
      + "6 and 13.5. To revisit it, re-measure that gap as the sample grows; a cap that "
      + "starts excluding resolved episodes in the 3–6 band is too low. Five of the seven "
      + "VPS rows are MOMENTUM XAUUSD, which points at stop refinement for that setup "
      + "specifically and is worth its own look.",
    harness: "python tasks/score_rr_rejections.py  ·  GET /api/rejection-evidence",
    // Rows are RECLASSIFIED to UNSCORABLE, never removed: rejections.jsonl is append-only
    // and was verified byte-identical on both boxes across the change, as was the frozen
    // rr_rejected.jsonl. Nothing was deleted and no signal is suppressed.
    feedsTheGate: false,
  },
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
    id: "edgeisgold",
    title: "The edge is Gold, not the engine",
    status: STATUS.ROBUST,
    measuredOn: "2026-08-14",
    evidence: "Per-instrument walk-forward at gate 70, 5 equal-count folds each, "
      + "0.05R/trade cost, on the live generateSignalMTF path. XAUUSD +0.219R/trade "
      + "over 130 closed, positive in 4 of 5 folds, +28.53R. BTCUSD +0.104R/trade over "
      + "59 closed, 3 of 5 folds, +6.16R. SP500 −0.819R/trade over 13 closed, 0 of 1 "
      + "scorable fold, −10.65R. Gold supplies 119% of the pooled +24.04R; SPX supplies "
      + "−44%. The headline pooled figure of +0.119R/trade is Gold's edge diluted by a "
      + "fold-unstable BTC and dragged by a negative SPX.",
    caveat: "SP500's negative sign is NOT a verdict — 13 closed trades, one scorable "
      + "fold and 1 win in 13. It is under-powered and must not be used to disable SPX; "
      + "it corroborates why SPX_H4_ONLY_BLOCKED_FLOOR exists and earns a proper cohort "
      + "walk-forward, not a switch. BTC is also weaker than the pooled number implies: "
      + "negative in folds 3 and 4. Live fills agree with the replay's shape — 4 of the "
      + "5 journal rows are XAUUSD.",
    changesTheAnswer: "This is the prerequisite for any 'add more instruments' proposal. "
      + "It says the edge is NOT a uniform property of the engine, so adding instruments "
      + "at random is as likely to add an SPX-shaped drag as a Gold-shaped winner. A "
      + "candidate instrument must clear the same per-instrument fold table BEFORE it is "
      + "wired in. Re-run with the per-instrument harness at gate 70; more closed SPX "
      + "trades would be the fastest thing to move this.",
    feedsTheGate: false,
  },
  {
    id: "minrr",
    title: "MIN_RR = 1.5",
    status: STATUS.CONTRADICTED,
    measuredOn: "2026-08-09",
    evidence: "Walk-forward: lowering to 1.35 buys 3 trades in 4 years and costs 6.6R. "
      + "Rejection ledger (VPS, re-read 2026-08-17, now 394 resolved): rejections would "
      + "have returned +20.61R, 67% would have won. At 86 resolved on 2026-08-09 the same "
      + "gate read +22.47R and 78% — so 4.6x the sample moved the R barely at all and cut "
      + "the win rate 11pp, which is what a shrinking edge looks like, not a stable one.",
    caveat: "The two disagree. The ledger is recent episodes in one regime on PAPER "
      + "entries with no spread, slippage or partial fills, on a fixed horizon; the "
      + "sweep is 4 years out-of-sample. THE WALK-FORWARD WINS. Neither has moved the "
      + "setting. The ledger's real signal is a DIRECTION SPLIT, and it has held while "
      + "every count grew: on 2026-08-17 the VPS reads RANGE_TRADE_LONG 174W/70L "
      + "(+19.09R) and BUY_OVERSOLD 37W/2L (+35.81R), against RANGE_TRADE_SHORT 53W/60L "
      + "(−36.39R). The shape survived; the earlier phrasing of it did not — "
      + "RANGE_TRADE_SHORT was 0W/8L when first read and is emphatically not winless now, "
      + "so any argument resting on 'it has never won' is void. See the ledgeroutlier "
      + "claim before reading ANY netR on this board as edge.",
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
      + "53W/60L for −36.39R, the worst net of any setup on the board. That last figure "
      + "is RE-CURATED: this claim used to say 0W/12L and \"the only setup on the board "
      + "with zero wins\", which was true at n=12 and is false at n=113. The verdict does "
      + "not change — it is still the worst setup — but the sentence that carried it was "
      + "the kind of never-won phrasing that ages into a lie, and it did. It also cited "
      + "−13.59R over "
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
    evidence: "Four closed fills in the system's entire life across 195 server "
      + "sessions: −$449.72 (BB_SQUEEZE_WATCH), −$99.10 (RANGE_TRADE_SHORT), −$6.64 "
      + "(SQUEEZE_BREAKOUT) and +$135.91 unattributed, gross −$419.55, expectancy "
      + "−$104.89/trade. One position is open. Win rate, calibration and per-setup edge "
      + "still rest on n=4, which is one trade per setup — below the 5-trade floor the "
      + "learning engine itself requires before it will act.",
    caveat: "The 2026-07-28 decision to trade a measured-negative edge in order to feed "
      + "the learning engine was deliberate and informed. Several of these closes only "
      + "arrived because reconciliation was repaired on 2026-08-11; before that they sat "
      + "OPEN indefinitely. The single WIN is not in learning.json at all — its setup "
      + "name was recorded as \"WAIT\", which updateLearning refuses to attribute rather "
      + "than invent a bucket for, so the learning engine's own record reads 0W/3L while "
      + "the journal reads 1W/3L. Any calibration claim must say which of the two it "
      + "means.",
    changesTheAnswer: "Sample. The rejection ledger is the only route that produces it "
      + "without funding the experiment. This claim has gone stale TWICE — it once read "
      + "n=1 and 119 sessions, then n=3 and 154, long after both had moved — so its "
      + "sample is now declared in sampleAtWriting and checked against the live journal "
      + "on every read. A mismatch raises needsRecuration rather than silently editing "
      + "the prose, because a curated claim that changes itself is worse than no claim.",
    // Declared so the drift can be DETECTED without the claim quietly rewriting itself.
    // See recurationCheck() below.
    //
    // ONLY closedFills. Session count and open-position count are quoted in the prose
    // as context, but they are not the sample this claim's argument rests on: sessions
    // increments on every server restart (179 -> 182 within an hour of writing this)
    // and open positions churn with ordinary trading. Triggering on either would raise
    // an item that can never be cleared, which trains you to skim past the one that
    // matters. n is what makes this claim true or false, so n is what is watched.
    //
    // The figure is the LAPTOP's journal. journal.json is per-machine, so this claim
    // flags needsRecuration on whichever box it was not written against — the VPS read
    // 3 closed / 2 open on 2026-08-17 while this says 4. That is the detector working,
    // not drift to chase: state the box, so a VPS reader knows why it fired instead of
    // meeting an item that can never clear. Re-curate when the LAPTOP's count moves.
    sampleAtWriting: { closedFills: 4 },
    sampleFrom: "laptop (THEMIS) journal.json",
    feedsTheGate: true,
  },
];

// ── Staleness detection for curated claims ──────────────────────────────────
//
// This file is CURATED BY DESIGN and must not silently recompute its own prose —
// see the header. But "curated" has meant "quietly wrong" twice on the liveconfig
// claim, which is fed to the AI Brain page AND into every agent's briefing, so a
// stale number here is repeated to every reader as a measured fact.
//
// The resolution is to detect, never to edit: a claim may declare the sample it was
// WRITTEN against, and this compares that against the live journal. A mismatch
// surfaces needsRecuration with both figures, so a human re-curates deliberately.
// Nothing here changes a claim's text, its status or its verdict.
function liveSample() {
  try {
    const fs = require("fs");
    const path = require("path");
    const journal = JSON.parse(fs.readFileSync(path.join(__dirname, "journal.json"), "utf8"));
    if (!Array.isArray(journal)) return null;
    const out = {
      closedFills: journal.filter(t => t && t.status === "CLOSED").length,
      openPositions: journal.filter(t => t && t.status === "OPEN").length,
      sessions: null,
    };
    try {
      const learning = JSON.parse(fs.readFileSync(path.join(__dirname, "learning.json"), "utf8"));
      if (Number.isFinite(learning?.sessionCount)) out.sessions = learning.sessionCount;
    } catch (e) { /* sessions stay null; the fill counts still work */ }
    return out;
  } catch (e) { return null; }
}

function recurationCheck(claim, live) {
  if (!claim.sampleAtWriting || !live) return null;
  const drifted = [];
  for (const key of Object.keys(claim.sampleAtWriting)) {
    const wrote = claim.sampleAtWriting[key];
    const now   = live[key];
    if (now === null || now === undefined) continue;
    if (now !== wrote) drifted.push(`${key}: written against ${wrote}, live is ${now}`);
  }
  if (!drifted.length) return null;
  return {
    needsRecuration: true,
    drifted,
    detail: "This claim's prose quotes a sample that has since moved. It is shown "
      + "unchanged on purpose — re-curate it by hand in server/evidence_register.js "
      + "rather than trusting the numbers in it.",
  };
}

function getRegister() {
  const live = liveSample();
  // Claims are returned UNCHANGED. The only addition is a staleness flag beside any
  // claim that declared the sample it was written against — detection, never editing.
  const claims = CLAIMS.map(c => {
    const stale = recurationCheck(c, live);
    return stale ? { ...c, staleness: stale } : c;
  });
  const needsRecuration = claims.filter(c => c.staleness).map(c => c.id);
  return {
    claims,
    counts: CLAIMS.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {}),
    curated: true,
    liveSample: live,
    needsRecuration,
    note: "Human-reviewed conclusions from harness runs. The live per-gate verdicts on "
      + "this board come from the rejection ledger and update themselves; these do not. "
      + "A claim listed in needsRecuration quotes a sample that has since moved — its "
      + "text is shown unchanged on purpose and must be re-curated by hand.",
  };
}

module.exports = { getRegister, CLAIMS, STATUS, liveSample, recurationCheck };
