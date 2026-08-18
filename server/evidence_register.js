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
    //
    // Guarded because its whole argument is a RATIO of one row to the rest: as resolved
    // episodes accumulate, a single +298R artifact stops being able to set the sign, and
    // the conclusion would need rewriting rather than merely updating.
    // RE-BASED 2026-08-18 from ROWS to EPISODES. 0c62efa made this board count one
    // episode per drifting setup instead of one row per refresh, so 476 became 73 on the
    // VPS overnight without a single new rejection. The old figure could never flag
    // again either, because recurationCheck fires on GROWTH only and this was a shrink.
    sampleAtWriting: { ledgerResolved: 73 },
    sampleTolerance: 0.5,
    sampleFrom: "VPS ledger (the peer box), EPISODES not rows — 73 resolved of 1061 "
      + "rows; the laptop read 53 of 768 the same day",
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
    measuredOn: "2026-08-18",
    evidence: "Re-measured 2026-08-18 on 769 trades, 5 sequential folds, 0.05R/trade "
      + "cost: 70 is positive in 4 of 5 (+0.182, −0.016, +0.423, +0.031, +0.057). The "
      + "case for 70 is no longer 'the only 5/5' — 55, 60 and 75 are also 4/5 on this "
      + "data. It is the BEST WORST FOLD: its single negative is −0.016, against −0.165 "
      + "at 55, −0.098 at 60 and −0.204 at 75. That is the property worth holding. "
      + "65 has DEGRADED from 3/5 to 2/5 UNSTABLE; 85 stays negative, now 0 of 4.",
    caveat: "The earlier '5 of 5' figure (2026-08-02, a0862d1) no longer reproduces and "
      + "should not be quoted. Nothing about it was wrong when written — the sample has "
      + "grown — but a claim of unanimity is exactly the kind that gets used to end an "
      + "argument, so the weaker true number replaces it. Separately, Gold's squeeze "
      + "cohort is pinned to exactly 70 (GOLD_SQUEEZE_MODERATE_CONFIDENCE): raise the "
      + "gate above 70 and that cohort silently stops firing.",
    changesTheAnswer: "A candidate gate that beats 70's worst fold across most folds, "
      + "not one with a better average. Re-run run_walkforward (MCP) or node "
      + "tasks/mtf_walkforward.cjs. Read the log timestamps — that file also holds a "
      + "superseded pre-b55b5f5 run. Any move above 70 must be paired with "
      + "cohort_reachability.cjs, or Gold's squeeze cohort dies unannounced.",
    feedsTheGate: true,
  },
  {
    // Raised 2026-08-18 because SPX has never traded and nothing on any board said
    // why in a way a reader could act on. It is not blind and it is not broken — it
    // has exactly one reachable path, and the tool built to catch dead cohorts cannot
    // see the two that are closed to it.
    id: "spxonepath",
    title: "SPX has no measured edge in any cohort",
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-18",
    // SETTLED the same day it was raised, by running the harness the earlier version of
    // this claim asked for. It was filed CONTRADICTED because the register held both
    // "the SPX evidence is under-powered and must not disable SPX" and a floor of 101
    // that effectively did. The fold table resolved it IN FAVOUR OF THE FLOOR.
    measured: "cohort_walkforward.cjs, 769 trades, 5 equal-count folds, 0.05R cost, "
      + "gate 70 read from disk (the 2026-08-11 run had fallen back to defaults because "
      + "strategy_settings.json was unreadable, so it was re-run clean). "
      + "SP500/DAILY+H4_AGREE — the ONLY path that can clear 70 for SPX — is -0.819R per "
      + "trade over 13 closed. SP500/DAILY_ONLY_H4_NEUTRAL is -0.395R over 49, positive "
      + "in 1 of 5 folds. The 2026-08-11 run, the last one taken before the floor "
      + "suppressed them, folded 166 closed SP500 H4-only trades: -0.196R STRONG, "
      + "-0.065R NONE, -0.039R MODERATE, positive in 1/5, 2/5 and 2/5 folds. Every SP500 "
      + "slice with n>=13 is negative; the only positive row is DAILY+H4_CONFLICT at n=2.",
    // The bars were cleared FIRST, because "the instrument is dead" and "the feed is
    // broken" look identical from the dashboard and only one of them is fixable here.
    dataCheck: "RSI recomputed independently from /api/mt5/candles/raw matches the "
      + "engine: d1 78.4 vs 77.6, h4 19.0 vs 18.1, h1 21.4. Daily strongly up over "
      + "months, last three days pulling back, H4/H1 oversold inside that pullback — a "
      + "normal buy-the-dip shape on real data. The feed is sound.",
    evidence: "Zero SPX fills in the journal's life against 4 XAUUSD and 1 BTCUSD. "
      + "Cause, from the MTF census (tasks/logs/mtf_walkforward.txt) and "
      + "cohort_reachability.cjs at gate 70: of SP500's 2,811 non-WAIT replay steps, "
      + "H4-only is 1,114 (40%) and is held at SPX_H4_ONLY_BLOCKED_FLOOR = 101 — and "
      + "would cap at 60 anyway; daily-only-with-neutral-H4 is 1,363 (48%) and caps at "
      + "55, because the two neutral-H4 cohorts that DO fire (base 70 and 72) are "
      + "written Gold-only and SPX has no equivalent; daily-vs-H4 conflict is 17 and "
      + "caps at 45. Only 'Daily+H4 agree' (base 72 both-MODERATE and up) can clear 70, "
      + "and that is 317 steps — 11% of SPX's setups. Live now: daily RSI 77.6 gives no "
      + "daily setup at all, so the live shape is H4-only, the blocked one.",
    caveat: "SPX not trading is CORRECT BEHAVIOUR, not blindness, and the floor is "
      + "vindicated — as is the separate, previously undocumented decision to write the "
      + "neutral-H4 cohorts Gold-only, since SPX's neutral-H4 record is -0.395R at 1/5. "
      + "But the floor now SUPPRESSES ITS OWN EVIDENCE: today's run produced no SP500 "
      + "H4-only rows at all, because blocked setups never become trades and so leave no "
      + "record to fold. The 166-trade table from 2026-08-11 is the last evidence that "
      + "will ever exist unless the floor is lifted for a measurement run. A guard that "
      + "has made itself unfalsifiable is the condition to watch here, NOT the sign of "
      + "the numbers, which is consistent across every SP500 slice.",
    changesTheAnswer: "Two things, neither of them lowering the floor on these numbers. "
      + "(1) To keep the floor falsifiable, re-run cohort_walkforward.cjs with the floor "
      + "lifted IN THE REPLAY ONLY — never in the live engine — so SPX H4-only keeps "
      + "producing a foldable record as history grows. Without that, this claim can only "
      + "ever be re-confirmed, never overturned. (2) SPX earns its place back on a cohort "
      + "that is ROBUST, not merely positive: the harness bar is most folds positive, and "
      + "no SP500 slice has ever cleared it. Live SPX fills would move this fastest and "
      + "there are none — which is the point, the block is why.",
    harness: "node tasks/cohort_walkforward.cjs  ·  node tasks/cohort_reachability.cjs",
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
    // This claim's ledger half read "86 resolved, +22.47R, 78%" for five days while the
    // VPS held 394 — and ai_brief.cjs served that to every agent under "Already MEASURED
    // — do not re-litigate". Declared so the next drift is DETECTED instead of waiting
    // for someone to re-read the ledger by hand.
    // RE-BASED 2026-08-18: 394 was a ROW count. In episodes the same VPS ledger reads 59.
    sampleAtWriting: { minRrResolved: 59 },
    sampleTolerance: 0.5,
    sampleFrom: "VPS ledger (the peer box) — its rejection ledger is the richer one",
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
    // The claim that aged worst: "0W/12L, the only setup on the board with zero wins" was
    // true at n=12 and false at n=113, and nothing noticed. A W/L pair is exactly the
    // shape that turns into a lie as it grows, so both halves are declared.
    // RE-BASED 2026-08-18: 53W/60L were ROW counts. In episodes the VPS reads 9W/10L,
    // netR -6.49. The SHAPE the claim rests on is unchanged — RANGE_TRADE_SHORT is still
    // the worst direction on the board and still emphatically not winless.
    sampleAtWriting: { rangeTradeShortWon: 9, rangeTradeShortLost: 10 },
    sampleTolerance: 0.5,
    sampleFrom: "VPS ledger (the peer box)",
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
    // The sizing decision this claim gates, measured 2026-08-18 and recorded here so it
    // is neither acted on early nor quietly forgotten. It is the largest single lever on
    // returns in the whole system and it requires NO new edge — which is exactly why it
    // needs a stated trigger rather than a judgement call on the day.
    sizingTrigger: "get_lot_size (mt5_bridge.py) ALREADY computes correct risk-based "
      + "lots from the broker's tick_value/tick_size, and `fixedLotSize` overrides it "
      + "entirely. So the change is one config value, 0.01 -> 0, not code. Measured "
      + "effect at 1% risk on a $94,189 balance: XAUUSD 0.01 -> 0.070 lots at a $134 "
      + "stop and 0.124 at a $76 stop (7-12x), BTCUSD unchanged at 0.010 because it "
      + "already risks 0.95% by accident of contract size. Fixed LOTS equalise nothing; "
      + "risk-based sizing equalises RISK, which is why the whole gain comes from "
      + "correctly weighting the 4-of-5-fold instrument. Annual expectation on the "
      + "measured per-instrument edges moves ~2.1% -> ~8.2%. "
      + "DO NOT FLIP IT YET. It multiplies LOSSES 7-12x identically; the live record is "
      + "1W/3L at -$419.55; and the only trade ever taken under risk-based sizing was "
      + "BB_SQUEEZE_WATCH at 0.14 lots for -$449.72, the largest loss in the journal. "
      + "BTC cannot go below 0.01 (broker minimum on both symbols), so there is no "
      + "de-risking version of this — the asymmetry can only be corrected upward. "
      + "TRIGGER: flip to 0 when XAUUSD alone has >=30 closed fills with positive "
      + "expectancy after costs. Gold, not pooled — the edge is Gold (see edgeisgold), "
      + "and pooling lets BTC's 3-of-5 record and SPX's negative one vote on a Gold "
      + "decision. At ~31 Gold trades a year that is roughly a year away, or sooner if "
      + "the rejection ledger settles it first. Re-read the 2026-07-28 note before "
      + "acting: 0.01 was chosen deliberately as a data-gathering safety.",
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
  const fs = require("fs");
  const path = require("path");
  // Every source guarded SEPARATELY, and the function always returns an object. The
  // previous version returned null for everything the moment journal.json was
  // unreadable, which silently disabled the staleness check on claims that do not rest
  // on the journal at all — a guard that switches itself off is worse than no guard.
  // recurationCheck skips any key that is null, so a partial reading is safe.
  const out = {
    closedFills: null, openPositions: null, sessions: null,
    ledgerResolved: null, minRrResolved: null,
    rangeTradeShortWon: null, rangeTradeShortLost: null,
  };
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(__dirname, "journal.json"), "utf8"));
    if (Array.isArray(journal)) {
      out.closedFills   = journal.filter(t => t && t.status === "CLOSED").length;
      out.openPositions = journal.filter(t => t && t.status === "OPEN").length;
    }
  } catch (e) { /* fills stay null */ }
  try {
    const learning = JSON.parse(fs.readFileSync(path.join(__dirname, "learning.json"), "utf8"));
    if (Number.isFinite(learning?.sessionCount)) out.sessions = learning.sessionCount;
  } catch (e) { /* sessions stay null */ }
  // The rejection ledger, which is what the fastest-moving claims here actually quote.
  // Without this they declared a sample nothing could check: MIN_RR's evidence said "86
  // resolved" for five days while the ledger held 394, and tasks/ai_brief.cjs served
  // that to every agent under "Already MEASURED — do not re-litigate". No circular
  // require: rejection_evidence pulls only fs and path and never references this file.
  try {
    const evidence = require("./rejection_evidence").buildEvidence();
    if (evidence && evidence.available !== false) {
      if (Number.isFinite(evidence.totals?.resolved)) out.ledgerResolved = evidence.totals.resolved;
      if (Number.isFinite(evidence.gates?.MIN_RR?.resolved)) out.minRrResolved = evidence.gates.MIN_RR.resolved;
      const shortSetup = evidence.setups?.RANGE_TRADE_SHORT;
      if (Number.isFinite(shortSetup?.won))  out.rangeTradeShortWon  = shortSetup.won;
      if (Number.isFinite(shortSetup?.lost)) out.rangeTradeShortLost = shortSetup.lost;
    }
  } catch (e) { /* ledger figures stay null; the journal ones still work */ }
  return out;
}

// `sampleTolerance` is a FRACTION, default 0 meaning exact. Exact is right for a slow,
// meaningful counter like closedFills, where every single new fill matters at n=4. It is
// wrong for a monotonically growing one: the rejection ledger gains rows every hour, so an
// exact check on it would flag every claim permanently and become the noise this file
// exists to avoid. 0.5 says "flag when it has moved enough that the conclusion could have
// changed" — MIN_RR going 86 -> 394 is a 358% move and would fire; a day's growth will not.
function recurationCheck(claim, live) {
  if (!claim.sampleAtWriting || !live) return null;
  const tolerance = Number.isFinite(claim.sampleTolerance) ? claim.sampleTolerance : 0;
  const drifted = [];
  for (const key of Object.keys(claim.sampleAtWriting)) {
    const wrote = claim.sampleAtWriting[key];
    const now   = live[key];
    if (now === null || now === undefined) continue;
    if (!Number.isFinite(wrote) || !Number.isFinite(now)) {
      if (now !== wrote) drifted.push(`${key}: written against ${wrote}, live is ${now}`);
      continue;
    }
    // GROWTH only, never shrinkage. journal.json and the ledger are both per-machine, so
    // a claim written against the VPS's 394 resolved episodes legitimately reads 125 on the
    // laptop — that is a smaller box, not an expired claim, and flagging it produced three
    // items that could never clear on this box. Every real staleness this file has suffered
    // was the sample OUTGROWING the prose: MIN_RR written at 86 while the ledger held 394,
    // RANGE_TRADE_SHORT written at 0W/12L while it reached 53W/60L. Growth is the signal.
    if (now <= wrote) continue;
    const move = (now - wrote) / Math.max(Math.abs(wrote), 1);
    if (move > tolerance) {
      drifted.push(`${key}: written against ${wrote}, live is ${now}`
        + ` (grown ${Math.round(move * 100)}%`
        + (tolerance > 0 ? `, tolerance ${Math.round(tolerance * 100)}%)` : ")"));
    }
  }
  if (!drifted.length) return null;
  return {
    needsRecuration: true,
    drifted,
    // Which box the prose describes. journal.json and the ledger are BOTH per-machine, so
    // a claim written against one box legitimately reads as drifted on the other. Saying
    // which box turns an item that looks unclearable into one a reader can act on.
    sampleFrom: claim.sampleFrom || null,
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
