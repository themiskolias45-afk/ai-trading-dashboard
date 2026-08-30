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
  // A harness ran and returned a real table that settles nothing — the candidates sit
  // inside what a single fold can move. Distinct from CANDIDATE, which means no
  // walk-forward has run, and from ROBUST, which means one did and answered. Without
  // this a swept-but-undecided claim has to borrow a label that overstates it in one
  // direction or the other.
  INCONCLUSIVE:     "MEASURED — INCONCLUSIVE",
};

// Ordered most-actionable first; the board renders in this order.
const CLAIMS = [
  {
    // Raised 2026-08-22. It goes near the top because it is the constraint the whole
    // system is currently bounded by, and because every surface in the project reports
    // the CONFIDENCE gate instead — which is not what is stopping the trades.
    id: "rsiceiling",
    title: "The RSI ceiling is the binding constraint on trade count — and its own sweep does not settle it",
    status: STATUS.INCONCLUSIVE,
    measuredOn: "2026-08-22",
    evidence: "MOMENTUM must sit under RSI 72 and TREND_FOLLOW under 68. On 2026-08-22 "
      + "the live near-miss census recorded 24 of 24 blocked setups failing on "
      + "RSI_ABOVE_CEILING — every one of them — the closest by 1.5 points (Gold H4 "
      + "MOMENTUM at 73.5). Over the same window the CONFIDENCE gate killed 1 and passed "
      + "0. First walk-forward, 3 assets, 2022-05..2026-07, 5 folds, 0.05R cost, scored "
      + "at gate 70 and judged on WORST FOLD: baseline 72/68 worst −0.108 (202 closed, "
      + "+24.0R, 4/5 positive). FOUR candidates beat that worst fold — 64/60 +0.033 "
      + "(180, +23.8R, 5/5), 80/76 −0.009 (236, +26.2R, 4/5), 88/84 +0.014 (249, "
      + "+18.8R, 5/5) and NO CEILING AT ALL +0.029 (264, +26.9R, 5/5). Only a much "
      + "tighter 56/52 is clearly worse: −0.326 worst, 2/5, −0.4R total. SECOND CUT, "
      + "same day: the identical population re-scored on five equal-TIME windows instead "
      + "of five equal-count buckets (RSI_CEILING_FOLD_MODE=time). The ranking survives — "
      + "the same four candidates clear the baseline and 56/52 is rejected under both — "
      + "but NOTHING is positive in all five folds under that cut, not one candidate and "
      + "not the baseline: 72/68 worst −0.092 (4/5), 64/60 −0.009 (3/5), 80/76 "
      + "−0.024 (4/5), 88/84 −0.089 (4/5), no ceiling −0.067 (4/5). THIRD CUT, same day: "
      + "re-scored on a PER-ASSET cost basis (spread/risk distance per trade) instead of "
      + "a flat 0.05R. Same four candidates clear the baseline again, 56/52 rejected "
      + "again: 72/68 worst −0.083 (4/5), 64/60 +0.064 (5/5), 80/76 +0.014 (5/5), "
      + "88/84 +0.056 (5/5), no ceiling +0.060 (5/5). Three independent cuts, one "
      + "answer.",
    caveat: "This does NOT say the ceiling is wrong, and it must not be used to move it. "
      + "Everything from 64 upward lands inside a 0.14R/trade spread, and the baseline's "
      + "weak worst fold is one window: in fold2 72/68 scores −0.108 while its immediate "
      + "neighbours score +0.095, −0.009 and +0.036. That is the shape of noise, not of "
      + "a bad threshold. The replay also stubs DXY, VIX, Fear&Greed, the cross-asset "
      + "signal cache and the learning boost. Both fold geometries have now been run, and "
      + "the comparison is itself a warning: the three 5/5 ROBUST labels from the "
      + "equal-count cut do not survive equal-time folds, so they were an artifact of "
      + "where the cuts fell rather than a property of those ceilings. 88/84 beats the "
      + "baseline by 0.003 under the second cut, which is not a result. The first run of "
      + "this harness also reported 64/60 at +63.5R "
      + "before rr was capped at 10 — ONE row with rr 49.71 supplied +39.7R of it, the "
      + "same artifact class as the rejection-ledger outlier at the top of this board. "
      + "READ THE PER-ASSET CUT WITH ITS BIAS IN MIND: that basis models SPREAD ONLY — "
      + "commission, swap and slippage are unmeasured — so it lowers cost for every "
      + "candidate, and a lower per-trade cost mechanically favours the candidates that "
      + "TRADE MORE, which is exactly the loose ceilings. That the baseline is the only "
      + "candidate above 64 with a negative fold under it is therefore suggestive and "
      + "not decisive, and it is why the flat 0.05R remains the headline basis.",
    changesTheAnswer: "LIVE FILLS — and now ONLY live fills. Both of the alternatives "
      + "this claim used to name have been run: equal-TIME folds and a per-asset cost "
      + "basis, 2026-08-22. All three cuts agree, and none settles it. The 64-to-no-ceiling range "
      + "is one flat cluster inside roughly 0.14R/trade under either geometry. A third "
      + "re-slicing of the same data is not independent evidence and should not be run as "
      + "though it were. What is still open is a different cost basis, or enough live "
      + "fills above the ceiling to corroborate the replay. A candidate has to beat "
      + "72/68's worst fold under BOTH cuts by more than one fold's worth of noise, not "
      + "merely beat it in one. Re-run: node tasks/rsi_ceiling_walkforward.cjs, then "
      + "again with RSI_CEILING_FOLD_MODE=time; each mode writes its own report. "
      + "Until then the live engine keeps 72/68 — strategy_settings.json carries neither "
      + "momentumRsiMax nor trendFollowRsiMax on either box, so both fall through to the "
      + "literals in generateSignal.",
    harness: "node tasks/rsi_ceiling_walkforward.cjs [RSI_CEILING_FOLD_MODE=count|time]",
    feedsTheGate: true,
  },
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
    changesTheAnswer: "Nothing cheap is left. Two independent attempts to exploit it have "
      + "now failed (see asEngineSetup and asConfidenceContributor), so the open question "
      + "is no longer whether CRT is real — it is whether ANY route from the pattern to a "
      + "trade exists on this engine. D1 is no longer the constraint: verified 2026-08-19, "
      + "BAR_COUNT_BY_TIMEFRAME is already 600 on d1, so the old 'raise it for a folded "
      + "walk-forward' note is stale for daily. H1 is still 400 bars (~2.5 months), which "
      + "is why the strongest single cell, SPX H1 (+0.156R), remains unfoldable.",
    harness: "node tasks/crt_walkforward.cjs  ·  node tasks/crt_mt5_transfer.cjs  ·  node tasks/crt_as_setup_walkforward.cjs  ·  node tasks/crt_confluence.cjs",
    // Added after the setup test. CRT stands up as a pattern and falls over as an
    // engine setup, and those are different claims — keeping only the first would
    // read as an unexploited opportunity when it has in fact been tried.
    asEngineSetup: "REJECTED 2026-08-09. Injected at the end of the setup chain and "
      + "replayed over 5 folds at gate 70: +3 trades for -0.054R, better in 0/5 folds. "
      + "It also is not cleanly additive — 19 CRT trades appeared while the total rose "
      + "by 3, because setting the daily leg to BUY/SELL moves the step out of the "
      + "H4_ONLY cohort and suppresses entries that used to clear the gate. A genuinely "
      + "additive test would need CRT to enter as its own timeframe leg.",
    // The test asEngineSetup said was still owed: CRT as a CONFIDENCE CONTRIBUTOR, which
    // is a pure partition of trades the engine already takes, so the displacement that
    // invalidated the setup test is structurally impossible. Kept as its own field for
    // the same reason — three different claims, three different answers.
    asConfidenceContributor: "REJECTED 2026-08-19. Partitioned 207 Gold / 59 SPX / 138 BTC "
      + "engine trades by whether a confirmed same-direction CRT completed within K daily "
      + "bars, K swept over 1,2,3,5,8, 5 folds, cost 0.05R. SP500 is consistently WORSE "
      + "with a nearby CRT at EVERY window (-0.574 to -0.055 against +0.468 to +1.392), "
      + "the opposite of the hypothesis. XAUUSD produced exactly one PASS, at K=8 only. "
      + "That is treated as noise and not as a finding: with 5 windows across 2 wireable "
      + "assets one spurious pass is the EXPECTED outcome, a real effect does not appear "
      + "at one window and vanish either side of it, and K=8 is also where the partition "
      + "stops partitioning — 118 of 207 trades land on the CRT side. The harness now "
      + "requires an ADJACENT window to agree before a PASS counts.",
    feedsTheGate: false,
  },
  {
    id: "regime",
    title: "Regime forecasting — can it see next week coming?",
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-19",
    evidence: "Two questions, opposite answers, measured separately on ~5 years of daily "
      + "broker bars using the ENGINE'S OWN regime label. PERSISTENCE: is the regime the "
      + "same in 5 days? 12 of 12 judgeable cells positive in EVERY fold across all three "
      + "assets, lifts +3 to +44pp over the base rate, still positive at 10 days. "
      + "DIRECTION: is price higher in 5 days given today's regime? TRENDING is 2/4, 2/4, "
      + "2/4 folds — a coin flip; SQUEEZE swings +11.9pp then -23.5pp between ADJACENT "
      + "folds on the same instrument. PROFITABILITY: no regime beats its own asset's "
      + "all-trade mean on the worst-fold standard — Gold TRENDING is closest at 3/4 folds "
      + "with a worst fold of -0.113.",
    caveat: "Every figure is a LIFT over the base rate in the same fold, deliberately: the "
      + "label is 64-78% TRENDING on every asset, so a raw hit rate would be mostly a "
      + "restatement of the majority class. VOLATILE is 0-1% of days and never judgeable; "
      + "RANGING is 2% on SPX. The profitability comparison is against each asset's OWN "
      + "mean, never against zero — against zero, Gold's +0.026..+0.220 baseline would "
      + "have made every one of its regimes look profitable and 'TRENDING makes money' "
      + "would have been a statement about Gold rather than about TRENDING.",
    changesTheAnswer: "Nothing about persistence — that result is unusually clean and does "
      + "not need re-measuring. The open door is whether a FINER regime label separates "
      + "expectancy where the current four-way one does not, and the prior is poor: "
      + "regimeveto failed its own year-split, and session and setup folds cleared nothing "
      + "either. Persistence tells you which setups to EXPECT, never which way to trade.",
    harness: "node tasks/regime_forecast.cjs  ·  node tasks/regime_edge.cjs",
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
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-28",
    evidence: "THE PATTERN WAS ABSENT BY CONSTRUCTION, NOT BY MARKET — every count below "
      + "dated before 2026-08-28 came from a detector that could not see it. detectAMD "
      + "required the distribution to close beyond the FULL opposite side of the "
      + "accumulation range inside ONE bar. Funnel on GOLD H4 over the whole archive: "
      + "7,844 windows -> 7,838 tight enough -> 1,092 clean SWEEPS -> 9 patterns. The "
      + "tightness filter discards 0.08% and the sweep test does real work at 14%; the "
      + "single-bar rule then threw away 99.2% of genuine sweeps. BTC D1 found ZERO in "
      + "1,821 bars. Distribution is a PHASE, not a bar. Fixed in 8d08145 "
      + "(distributionBars, default 5). Counts by the real detector: D1 gold 3->11, btc "
      + "0->14, spx 1->15; H4 gold 9->70, btc 18->108, spx 13->76; H1 gold 97->432, btc "
      + "78->479, spx 176->685 — 1,596 H1 patterns where there were 351, sessionAligned "
      + "true throughout. AND THEN IT STILL DOES NOT PAY. Entry at the distribution "
      + "close, stop at the pattern's own invalidation, target swept as a multiple of "
      + "that risk, cost 0.05R, 5 sequential out-of-sample folds: NOTHING reaches 4 of 5 "
      + "folds on any asset or timeframe. Best cells are BTC H1 at 0.5R (+0.009R, 3/5, "
      + "n=422) and SPX H4 at 1.0R (+0.111R, 3/5, n=62). The native objective averages "
      + "only ~0.44R, which is why a 67% hit rate still lost.",
    caveat: "THE WIN RATE IS A TRAP AND MUST NOT BE QUOTED ALONE. At a 0.5R target the "
      + "pattern is right 64-75% of the time, which reads like a strong edge; demand a "
      + "real move and it collapses — GOLD H1 goes 66% at 0.5R, 50% at 1R, 38% at 1.5R, "
      + "26% at 2R. Win rate decaying in lockstep with target distance is the signature "
      + "of price wiggling near entry, not of prediction. A 67% hit rate at sub-1R "
      + "payoff is exactly how a losing system looks reassuring. Also: this scores the "
      + "pattern's own geometry only, the detection fix is one judgement (5 bars, under "
      + "half the 12-bar accumulation window) rather than a measurement, and AMD feeds "
      + "no gate, no confidence and no sizing — detectAMD has no production caller at "
      + "all, so none of this has ever touched a trade.",
    changesTheAnswer: "THIS IS NOW OPEN, NOT CLOSED — the previous version of this claim "
      + "said 'the pattern is not there, at any timeframe, on any asset, stop re-running "
      + "it', and that was true of a detector that could not see it. What is refuted is "
      + "AMD'S OWN GEOMETRY, not AMD. Worth trying, in order: a target derived from "
      + "something other than one accumulation range (session range, ATR, the next "
      + "opposing structure); the distributionBarsTaken field now carried on every "
      + "pattern, to ask whether fast markdowns behave differently from slow ones; the "
      + "classic ASIA-accumulation / LONDON-sweep / NEW-YORK-distribution subset scored "
      + "SEPARATELY, since pooling a minority shape with things that merely resemble it "
      + "is what made the 2026-08-12 number uninterpretable; and a materially bearish "
      + "regime, the same caveat BREAKDOWN carries. Re-running the OLD sweep on the same "
      + "bars is not independent evidence and should not be repeated.",
    harness: "node tasks/geometry_measure.cjs --interval 1h  |  node tasks/crt_amd_mtf_measure.cjs",
    supersededEvidence: "NOW SESSION-ALIGNED, and still far too thin to judge. On 13,757 real "
      + "Gold hourly bars (2 years) the detector finds 16 patterns, of which only 3 are "
      + "the textbook ASIA accumulation → LONDON sweep → NEW YORK distribution. The "
      + "most common sequence is ASIA → NEW YORK → NEW YORK (6). An earlier run that "
      + "pooled every shape together reported 33 resolved trades across three assets.",
    // The historical caveat and falsifier, kept rather than dropped because they record
    // a real diagnostic path — the 2026-08-12 session correctly found and fixed the
    // sessionAligned bug — and because the conclusion they led to was reasonable given
    // the detector they had. It is the DETECTOR that was wrong, not the reasoning.
    supersededCaveat: "The block has MOVED and its old reason was stale. The bridge has "
      + "sent bar open times since 2026-08-09; what was actually missing is that "
      + "detectAMD never read them and hardcoded sessionAligned:false, while "
      + "geometry_measure.cjs threw the timestamps away in its own loader. Both fixed "
      + "2026-08-12. What blocks AMD now is SAMPLE SIZE, not missing data.",
    //
    // THE COUNTS BELOW ARE THE BROKEN DETECTOR'S, AND THE CONCLUSION DRAWN FROM THEM WAS
    // WRONG. Kept verbatim because this is the exact shape of the mistake: a measurement
    // repeated on more history, re-confirmed on live bars, sharpened into a table, and
    // stated with total confidence — while every number came from an instrument that
    // could not see the thing. More data cannot rescue a detector that is broken, and
    // "we re-ran it on five years and it replicated" is not the check people think it is.
    //
    //   RE-RUN 2026-08-27 on the 4.3-YEAR archive, and five years changes nothing:
    //   the best AMD cell is btc h4->h4 at n=16, and NOT ONE AMD cell cleared 20 trades.
    //   The pattern is not there, at any timeframe, on any asset. Stop re-running it.
    //            d1   h4   h1   m15
    //     btc     0    1    1     4
    //     gold    0    0    0     6
    //     spx     1    0    7     9
    //
    // Re-measured 2026-08-28 with the distribution leg allowed more than one bar, the
    // same H1 series yield 432 / 479 / 685. The sentence "the pattern is not there" was
    // the single most expensive line in this register: it is what told every agent
    // reading ai_brief.md that AMD was closed, which is why 23 AI-employee proposals
    // never once touched it.
    feedsTheGate: false,
  },
  {
    id: "crtmtf",
    title: "CRT bias timeframe x execution timeframe (is 4H bias + 15m execution best?)",
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-27",
    evidence: "ANSWERED on the 4.3-year archive, run independently on BOTH boxes. The first pass used the bridge cache (4000 m15 / 400 h4 bars, ~42-93 days) and every cell came back UNDERPOWERED; tasks/history/*.csv already held ~102,000 m15 and ~7,900 h4 bars per symbol on the same broker instruments, which is what the m15 push was added to top up. 18 cells now clear 20 trades AND 5 usable folds. EXACTLY ONE PASSES the bar this repo holds a threshold to - worst fold positive and every fold positive: CRT GOLD h4→h4, n=584, worst fold +0.0215, 5/5, R/trade +0.1052 (VPS independently: n=585, +0.0234, 5/5, +0.1034). 15m execution is NOT best and is never best on any asset. Worst-fold ranking - GOLD h4→m15 -0.0766 < h4→h1 -0.0147 < h4→h4 +0.0215; BTC h4→m15 -0.1892 < h4→h1 -0.0802 < h4→h4 -0.0394; SPX h4→m15 -0.1214 < h4→h4 -0.1737 < h4→h1 -0.1016. The 4H BIAS was right - every d1-bias cell is worse, worst folds -0.19 to -0.47 - it is the 15m EXECUTION that is not.",
    caveat: "The one PASS is SPREAD-SENSITIVE and is not a free edge. Gold h4→h4 breaks even at 2.15% of risk, and its average risk distance is 0.48% of price = about $22 at $4600, so break-even is ~$0.47 round trip. Against the $0.20–$0.50 XAUUSD spread already on record it stays positive at $0.20/$0.30/$0.40 and goes NEGATIVE at $0.50. Break-even here is quoted on the WORST FOLD, not the mean, because a cell whose mean survives a cost while its worst fold does not loses money in the year that matters. Note also how badly a thin sample flattered this: on the bridge cache the same cell read +0.3505 R/trade against +0.1052 on the full archive, 3.3x - which is what UNDERPOWERED means, demonstrated rather than asserted.",
    changesTheAnswer: "For the 15m question, nothing cheap - it lost on all three assets over five years with 484-611 trades per cell, and that is not a sample problem. For the Gold h4→h4 PASS, the open item is a MEASURED spread: this repo logs only the 50-point cap and never an observed spread, so the $0.20–$0.50 range is inherited, not measured on this account. Log real spreads at fill time and the break-even question answers itself. Do NOT raise the bridge bar count to get more history - the push already sits near 930KB of a 2MB limit and an oversized push is rejected 413 as a WHOLE, after which the server silently falls back to Yahoo bars. The archive is the intended long source.",
    harness: "node tasks/crt_amd_mtf_measure.cjs [--hold 96] [--folds 5] [--emit]",
    // Standalone CRT only. CRT remains CLOSED as an ENGINE INPUT - see the crt claim
    // above: six measurements, six negatives. This is a different question.
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
    // Raised 2026-08-30. Sits directly under edgeisgold because it is the work that
    // claim ASKED FOR -- "a candidate instrument must clear the same per-instrument
    // fold table before it is wired in" -- and it corroborates it from a different
    // direction: Gold first of 51, SPX last.
    id: "instrumentscan",
    title: "The engine is long-beta, and SPX is the weakest instrument it trades",
    status: STATUS.CANDIDATE,
    measuredOn: "2026-08-30",
    evidence: "51 instruments replayed through the LIVE engine (generateSignal via "
      + "tasks/_replay_engine.cjs), 10y daily bars, 0.05R/trade, EXPIRED scored 0R. "
      + "THE ENGINE IS LONG-BETA: pooled across all 51 names, expectancy per trade "
      + "tracks the S&P calendar return almost one-for-one -- 2017 (+19.4%) +0.418, "
      + "2019 (+28.9%) +0.247, 2024 (+23.3%) +0.207, 2018 (-6.2%) +0.011, and 2022 "
      + "(-19.4%) -0.232 across 591 trades for -136.9R. It is ~92% long (QQQ 154 BUY / "
      + "14 SELL; NVDA 51/1). GOLD IS FIRST ON EVERY CUT: #1 on the naive ranking, #1 "
      + "on an identical-window comparison at +0.471R/trade, 5/5 folds with the "
      + "strongest worst fold at +0.142, and positive through 2022 (+4.97R). SPX IS "
      + "LAST: on the identical window (2022-07-28..2026-08-03) SP500 is -0.047R/trade "
      + "against QQQ +0.438, NVDA +0.434, TSM +0.380, GLD +0.315; on 5 folds SP500 is "
      + "2/5 with a worst fold of -0.863, the worst record measured. SPY at +0.065 "
      + "rules out a data-source artifact -- same index, same feed as the rest. Broker "
      + "check 2026-08-30: NAS100, QQQ, SMH and BAC are all in the book at "
      + "trade_mode 4 (FULL), and NAS100's min lot is 0.1, identical to SP500.",
    caveat: "THIS IS A D1 SCREEN, NOT THE HARNESS edgeisgold USED. That claim ran "
      + "generateSignalMTF at gate 70 -- the live multi-timeframe path; this ran the "
      + "single-timeframe daily replay, so its trade counts are far higher than live "
      + "firing rates and its trade set is not the one the live engine would take. It "
      + "therefore does NOT yet clear the bar edgeisgold set for wiring an instrument "
      + "in. The naive ranking is also mostly beta and must not be read as skill: 31 of "
      + "51 names were positive out-of-sample because every holdout window fell in the "
      + "2023-26 bull run, so a 61% base rate is the number to compare any hit rate "
      + "against. The 48 candidates were replayed on YAHOO bars, not broker bars, while "
      + "the three owned instruments used real MT5 history -- a CFD's prices differ "
      + "from the underlying, which on this system is the known gold futures/spot "
      + "basis. No spread, slippage, commission or gap-through-stop is modelled beyond "
      + "the flat 0.05R, and as of this writing NAS100's live spread is still "
      + "UNMEASURED -- every weekend reading is a stale last-quote, not a cost.",
    // 2026-08-30, same day: the MTF run this asked for WAS ATTEMPTED and FAILED ITS
    // OWN CONTROL. Recorded here rather than dropped, so the next session does not
    // spend another pass rediscovering that Yahoo bars cannot answer this.
    mtfAttempt: "Built matched D1/H4/H1 sets for ^NDX and ^GSPC from Yahoo (H4 "
      + "resampled from hourly, both capped at Yahoo's 730d hourly limit) and ran "
      + "tasks/_replay_mtf.cjs at gate 70. Result: NDX -0.052R/trade over 43, 2/5 folds; "
      + "Yahoo-SPX +0.386 over 43, 2/5 folds -- which would say NDX is WORSE than SPX, "
      + "the opposite of the D1 screen. BUT THE CONTROL DISAGREES WITH ITSELF: on the "
      + "identical 2024-03+ window, real MT5 SP500 scores -0.542 over 59 with ZERO wins, "
      + "while Yahoo ^GSPC scores +0.468 over 40. Same index, same window, opposite sign, "
      + "so the difference is the DATA SOURCE. Root cause found: MAX_HOLD is 40 H4 BARS, "
      + "and a broker 24h CFD gives 6 H4 bars a day (6.7 days of hold) while H4 resampled "
      + "from a 6.5h US cash session gives ~1.6 a day (24.6 days) -- 3.7x longer to reach "
      + "target. The EXPIRED share confirms it: 54.5% on broker bars, 16.3% on Yahoo. "
      + "CONCLUSION: neither NDX number here is usable, in either direction.",
    // 2026-08-30, third cut: the horizon bug was FIXED and everything re-measured on
    // the live MTF path. The answer is that nothing clears the bar.
    mtfCorrected: "MTF_MAX_HOLD added to tasks/_replay_mtf.cjs (default unchanged at 40) "
      + "so the holding horizon can be matched across feeds: 40 broker H4 bars = 6.7 days "
      + "= 11 Yahoo cash-session H4 bars. Re-run at hold=11, gate 70. The control largely "
      + "recovered -- Yahoo ^GSPC fell from +0.386 to +0.020 and its EXPIRED share rose "
      + "from 16.3% to 64.9%, against MT5 SP500's 52.5% -- but did NOT close: the same "
      + "index still reads +0.020 on Yahoo against -0.525 on broker bars, a RESIDUAL FEED "
      + "BIAS of +0.545R/trade. Raw results at the corrected horizon: BAC +0.476 (n=57, "
      + "3/5 folds), NWG +0.381 (79, 2/5), HUBS +0.328 (16, 3/5), TDOC +0.075 (16, 3/5), "
      + "SPX +0.020 (57, 2/5), NDX -0.053 (62, 1/5 folds -- the worst record of anything "
      + "tested). SUBTRACT THE MEASURED BIAS AND EVERY ONE GOES NEGATIVE: BAC -0.069, "
      + "NWG -0.164, HUBS -0.217, TDOC -0.470, SPX -0.525, NDX -0.598. XAUUSD's +0.219 "
      + "needs no adjustment because it was measured on real broker bars. CONCLUSION: no "
      + "index and no stock is demonstrably profitable on the live path, and NAS100 is the "
      + "weakest of them.",
    changesTheAnswer: "NAS100 IS NOT SETTLED AND THE SWAP IS NOT SUPPORTED BY EVIDENCE "
      + "YET -- the D1 screen favours it, the only MTF attempt could not be trusted, and "
      + "those are the two cuts that exist. It needs BROKER NAS100 bars on D1/H4/H1, "
      + "which means adding NAS100 to the bridge's SYMBOL_CANDIDATES for DATA COLLECTION "
      + "ONLY, never to TRADABLE_KEYS, and waiting for enough history to fold. Do not "
      + "retry this on Yahoo intraday bars: the holding horizon cannot be made to match. "
      + "Then run the same walk-forward edgeisgold used and require most folds positive "
      + "judged on the WORST fold. Before that, two cheaper things can kill the proposal outright: a "
      + "measured NAS100 spread that trips maxSpreadPts (SP500 already reads 45 against "
      + "a cap of 50, and tasks/spread_probe.py is sampling the Monday session on both "
      + "boxes), or a min-lot/point-value combination that breaks sizing. Note also "
      + "that mt5_bridge.py's own comment independently records SPX at PF 0.32 full "
      + "sample and 0.00 on the held-out half through generateSignalMTF, which is the "
      + "stronger path and agrees with this. Nothing here argues for adding instruments "
      + "generally: the binding constraint is sample size, and a second index trading "
      + "~15 times a year does not fix it.",
    harness: "node tasks/instrument_universe_scan.cjs  ·  node tasks/fetch_yahoo_history.cjs "
      + "<sym> tasks/history_yahoo/<sym>_D1.csv  ·  python tasks/spread_probe.py --report",
    feedsTheGate: false,
  },
  {
    // Raised 2026-08-30. Placed high because it does not merely add a claim -- it says
    // a measurement parameter has been biasing OTHER claims on this board downward.
    id: "holdhorizon",
    title: "MAX_HOLD=40 is a backtest artifact that made SP500 look far worse than it is",
    status: STATUS.ROBUST,
    measuredOn: "2026-08-30",
    evidence: "There is NO max-hold anywhere in the live system -- not in mt5_bridge.py, "
      + "not in server/index.js -- so a replay that closes a trade at 40 H4 bars scores a "
      + "still-running trade as a flat scratch. Swept MTF_MAX_HOLD on REAL BROKER BARS "
      + "(exported 6y via tasks/export_mt5_history.py), live MTF path, gate 70, 0.05R: "
      + "SP500 -0.379R/trade at hold 40 (88 trades, 55% EXPIRED, 1/5 folds) -> -0.220 at "
      + "80 -> +0.086 at 160 -> **+0.241 at 320** (50 trades, 4% expired, 3/5 folds). "
      + "XAUUSD +0.173 (40% expired, 3/5) -> **+0.575 at 320** (1% expired, 5/5 folds). "
      + "NAS100 -0.098 (56% expired) -> +0.223 at 320 (4/5). The harness ALREADY models "
      + "position occupancy (`if (i <= openUntil) continue`), so the falling trade counts "
      + "are the DUPLICATE gate being respected, not overlapping positions being counted.",
    caveat: "THE DEFAULT WAS DELIBERATELY LEFT AT 40. cohort_walkforward.cjs and nine "
      + "other callers have stored claims scored against it -- including spxonepath and "
      + "edgeisgold on this same board -- and moving the default would silently move every "
      + "one of those numbers. The harness now WARNS on stderr above a 20% expired share "
      + "instead. This does NOT mean the long-horizon numbers are the true ones and the "
      + "short ones false: a 53-day hold is real (the live Gold position opened 2026-08-28 "
      + "is still open) but it also means that symbol is blocked to new entries for 53 "
      + "days, so throughput falls -- SP500 goes from 88 trades to 50. Higher R per trade "
      + "on fewer trades is not automatically more money.",
    changesTheAnswer: "REVERSES the standing advice to reduce SP500. At a horizon that "
      + "matches live behaviour SP500 is +0.241R/trade and positive in 3 of 5 folds, not "
      + "the -0.375 disaster the 40-bar default reported. It is still the weakest of the "
      + "instruments measured and still worth watching, but the case for removing it is "
      + "GONE. Re-score spxonepath and edgeisgold at MTF_MAX_HOLD=320 before either is "
      + "quoted again -- both were measured under the artifact. The open question this "
      + "raises is whether the ENGINE should carry a time stop at all: nothing closes a "
      + "stalled trade today, and a symbol held 53 days is a symbol not trading.",
    harness: "MTF_MAX_HOLD=320 node tasks/_replay_mtf.cjs . SP500 ^GSPC 70  ·  "
      + "python tasks/export_mt5_history.py NAS100 BAC",
    feedsTheGate: false,
  },
  {
    id: "minrr",
    title: "MIN_RR = 1.5",
    status: STATUS.ROBUST,
    measuredOn: "2026-08-24",
    evidence: "RE-RUN 2026-08-24 on bars 29 days fresher than any previous sweep, and it "
      + "REPLICATED. tasks/minrr_direction_walkforward.cjs, 3 assets, 5 sequential "
      + "out-of-sample folds, gate 70, 0.05R/trade. The BASELINE 1.50/1.50 is positive "
      + "in 5 of 5 folds at +0.205R/trade over 264 trades (+0.226, +0.071, +0.482, "
      + "+0.101, +0.168) — that is evidence FOR the bar, not merely absence of evidence "
      + "against it. No challenger clears. The best, 1.35 long / 1.50 short, shows "
      + "+0.364R against the baseline's +0.205R and looks decisive until the folds are "
      + "read: it is better in only 3 of 5, and the delta sum of +0.712 becomes MINUS "
      + "0.036 with fold 2 removed. Loosening longs to 1.25 is better in 2/5. Raising "
      + "shorts alone to 1.75 is better in 0 of 5, with three folds at exactly +0.000 — "
      + "it moved one trade in 264. 1.50/2.00 is 3/5 for +0.022R while REMOVING 4 "
      + "trades. The earlier run of this same harness reported +0.158R with 109% of it "
      + "in one fold; today reads +0.158R with 105% in one fold. Two runs, different "
      + "data, same answer.",
    caveat: "THE CONTRADICTION HAS RESOLVED, and it resolved toward the walk-forward. This "
      + "claim was filed CONTRADICTED because the VPS ledger read +20.61R at 67% "
      + "would-have-won over 59 episodes while the sweep said do not move it. Re-read "
      + "2026-08-24 at 83 episodes, that same ledger now reads netR MINUS 2.73 at 60% "
      + "and its own verdict is NO MEASURABLE COST. It stopped objecting. The direction "
      + "split that was the ledger's real signal has decayed with it: BUY_OVERSOLD is "
      + "8W/4L on the VPS today, so the never-loses phrasing is void exactly as "
      + "RANGE_TRADE_SHORT's never-wins phrasing was voided before it — that is TWICE a "
      + "W/L pair here has aged into a lie, and it is why both halves are declared. THE "
      + "TWO BOXES NOW DISAGREE WITH EACH OTHER: the laptop's smaller ledger still "
      + "reads +15.33R at 78% over 54 episodes and still says COSTING MONEY. The VPS is "
      + "the source of record for this claim. Read the ledgeroutlier claim before "
      + "treating ANY netR here as edge.",
    changesTheAnswer: "The candidates are NOT PROVEN, which is not the same as refuted — do not cite "
      + "this as evidence that a lower long bar is harmful. To move the bar you need a "
      + "candidate better in MOST folds whose gain survives deleting its best fold; "
      + "every long-loosened candidate here goes negative under that test. Note also "
      + "that fold 2 reads +0.819 for all four long-loosened variants and the delta is "
      + "+0.748 in all four, identical to three decimals — dropping the long bar from "
      + "1.50 to 1.35 and to 1.25 admits the SAME winning trade, so one trade is doing "
      + "the work, not a population. Shorts are settled: 0/5 better at 1.75, and 2.00 "
      + "buys +0.022R for 4 fewer trades, which is a bad trade when sample is the "
      + "binding constraint. Re-run as the ledger grows, and re-read it if the VPS "
      + "verdict swings back to COSTING MONEY.",
    // This claim's ledger half read "86 resolved, +22.47R, 78%" for five days while the
    // VPS held 394 — and ai_brief.cjs served that to every agent under "Already MEASURED
    // — do not re-litigate". Declared so the next drift is DETECTED instead of waiting
    // for someone to re-read the ledger by hand.
    // RE-BASED 2026-08-18: 394 was a ROW count. In episodes the same VPS ledger reads 59.
    // RE-BASED 2026-08-24: 59 -> 83 episodes on the VPS. At 59 the gate read +20.61R
    // and COSTING MONEY; at 83 it reads -2.73R and NO MEASURABLE COST, so the sample
    // that grew is the same sample that removed the contradiction.
    sampleAtWriting: { minRrResolved: 83 },
    sampleTolerance: 0.5,
    sampleFrom: "VPS ledger (the peer box) — its rejection ledger is the richer one; 83 "
      + "resolved episodes there against 54 on the laptop, and the two now give "
      + "OPPOSITE verdicts",
    harness: "node tasks/minrr_direction_walkforward.cjs [--folds 5] [--gate 70]",
    feedsTheGate: true,
  },
  {
    // Raised and settled the same day, 2026-08-28, from the question "why does it only
    // ever go long". The answer was structural rather than statistical, which is why it
    // had to be BUILT before it could be measured at all.
    id: "breakdown",
    title: "BREAKDOWN — a short trend-continuation setup, the mirror of MOMENTUM",
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-28",
    evidence: "The engine had EIGHT long branches and FOUR short ones, and the gap was a "
      + "whole CATEGORY: DIVERGENCE and SQUEEZE_BREAKOUT are symmetric pairs, the long "
      + "side additionally had three trend-continuation setups (BREAKOUT, MOMENTUM, "
      + "TREND_FOLLOW), and the short side had NONE — SELL_BOUNCE and RANGE_TRADE_SHORT "
      + "are both mean-reversion. A clean downtrend below all EMAs with bearish MACD "
      + "matched no branch and fell out as WAIT. BREAKDOWN was built as the exact mirror "
      + "of MOMENTUM (its RSI band is derived as 100 minus MOMENTUM's, so it cannot "
      + "drift) and replayed against a flag-off baseline over 4.3 years — 818 baseline "
      + "trades vs 886 candidate. At the live gate 70 it is 22 closed, −0.368R/trade, "
      + "worst scored fold −0.383, and only 2 of 5 folds reach 5 closed trades. It also "
      + "drags the SYSTEM's worst fold from +0.186 to +0.076. Fails all three checks.",
    caveat: "It ships OFF and stays off: strategySettings.breakdownEnabled defaults false "
      + "and neither box carries the key. The branch sits LAST in the else-if chain so it "
      + "can only convert a cycle that was already WAIT — proven, not argued, by "
      + "replaying both sides of the edit with the flag off and getting byte-identical "
      + "trade lists on all three assets. Displacement was measured rather than assumed: "
      + "74 baseline trades vanish under the candidate through position occupancy, but "
      + "the 12 that closed at the gate were worth −2.60R, so displacement was a small "
      + "SAVING and is not what sinks this. The cohort's own losses are. Macro filters "
      + "and the learning boost are stubbed in the replay, so a setup that would live or "
      + "die on those is not what was measured here.",
    changesTheAnswer: "A cohort worst fold above zero at the live gate with at least 3 of "
      + "5 folds scoring, AND a system worst fold no lower than the baseline's. The "
      + "sample is thin BY CONSTRUCTION — this is the short side of a four-year window "
      + "that was mostly up — so a materially bearish regime is the honest re-test. The "
      + "band is derived from momentumRsiMax, so an RSI-ceiling sweep moves this too.",
    harness: "node tasks/breakdown_walkforward.cjs",
    sampleAtWriting: { closedAtGate: 22, foldsScored: 2 },
    sampleTolerance: 0.5,
    sampleFrom: "MTF replay, both worlds, 2022-04 to 2026-08",
    feedsTheGate: false,
  },
  {
    // Placed directly under BREAKDOWN because the two are constantly confused and are
    // NOT the same question. BREAKDOWN is MOMENTUM's mirror: a trend-continuation short
    // that needs an established downtrend. This is a RANGE-BREAK short, which needs no
    // trend at all — and it is the one people reach for after watching a fast drop out
    // of a range. Both fail, for different reasons, and neither is a reason to try the
    // other.
    id: "shadowshort",
    title: "Break-down short — chasing a fast drop out of the range",
    status: STATUS.MEASURED_NO_EDGE,
    measuredOn: "2026-08-28",
    evidence: "Raised 2026-08-28 after Gold fell 4631 -> 4530 inside ONE H1 bar while "
      + "/api/signals still read BUY MOMENTUM confidence 74, unchanged. Tested against "
      + "the 5.1-year H1 archive (GOLD 30,024 bars, BTC 42,200, SPX 29,992). Plain "
      + "Donchian break-down — close below the 20-bar low, 1.5x ATR14 stop, 2R target, "
      + "0.05R cost, stop assumed filled before target when both land in one bar, no "
      + "overlapping positions: GOLD −0.119R over 594 trades and 0/5 folds positive, BTC "
      + "−0.063R over 844 and 1/5, SPX −0.116R over 685 and 1/5. The decisive test is the "
      + "NESTED walk-forward, where each fold's parameters are chosen only on folds "
      + "before it: GOLD in-sample +0.26R -> OOS 2/4 folds and mean +0.005R; BTC +0.85R "
      + "-> 2/4 and +0.185R; SPX +0.93R -> 1/4 and −0.063R. In-sample +0.26..+0.93R "
      + "collapsing to zero is the whole finding. Live confirmation from a different "
      + "source the same day: the shadow ledger's first run priced 240 resolved episodes "
      + "over ~50 days of live bars at GOLD −0.013R, BTC −0.142R, SPX −0.110R.",
    caveat: "A FLAT 216-VARIANT SWEEP FIRST RETURNED +1.45R WITH 108 OF 216 VARIANTS "
      + "'WINNING', AND THAT WAS A LOOK-AHEAD BUG — recorded here because the shape "
      + "recurs. The variant filled a resting sell-stop at the break level while the "
      + "volatility filter read (high−low)/ATR of the TRIGGERING bar, a number that does "
      + "not exist until that bar closes, hours after the fill; resolution also began at "
      + "bar i+1, banking the whole intrabar collapse before the first stop check. 108 of "
      + "216 winning was itself the tell — a real edge does not appear in half a grid. "
      + "Corrected, survivors fell to 2 of 216, neither holding on BTC or SPX. Separately, "
      + "the move that prompted this was smaller than it looked: 59% of the 101-point bar "
      + "sat ABOVE the 10-bar low, inside the range where nothing can trigger, leaving "
      + "41.6 points against an H1 ATR of 22.16 — about 1.9R at a perfect fill, not the "
      + "4.5R the headline number suggests. Enabling BREAKDOWN would NOT have caught it "
      + "either: that setup requires a downtrend, and Gold was MIXED/UPTREND/STRONG "
      + "UPTREND on h1/h4/d1.",
    changesTheAnswer: "Several hundred resolved episodes from LIVE bars turning the mean "
      + "positive on MORE THAN ONE asset. That is what tasks/shadow_short_ledger.py now "
      + "accumulates nightly on both boxes, served read-only at /api/shadow-shorts and "
      + "rendered live as 'Moves With No Setup' on the AUTO TRADE tab, under 'Why Nothing "
      + "Fired'. It is not repeated here on purpose: this claim is the settled verdict and "
      + "that card is the running count, and a number kept in two places is the single most "
      + "repeated defect in this codebase. A "
      + "wider grid over the same 5.1 years is NOT independent evidence and must not be "
      + "run as though it were — that is the thing that already failed. A materially "
      + "bearish regime is the honest re-test, the same caveat BREAKDOWN carries.",
    harness: "python tasks/shadow_short_ledger.py  (live) · "
      + "python tasks/would_a_short_have_fired.py [asset] [bars]  (does any branch fire)",
    sampleAtWriting: { resolvedEpisodes: 240, oosFoldsPositiveGold: 2 },
    sampleTolerance: 0.5,
    sampleFrom: "5.1y H1 archive nested walk-forward + live shadow ledger, 2026-08-28",
    feedsTheGate: false,
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
    measuredOn: "2026-08-24",
    evidence: "FIVE closed fills in the system's entire life across 247 server sessions. In "
      + "order of close: BB_SQUEEZE_WATCH XAUUSD -$449.72 at 0.14 lots (conf 85), an "
      + "unattributed XAUUSD win +$135.91 at 0.01 (conf 70), RANGE_TRADE_SHORT XAUUSD "
      + "-$99.10 at 0.01 (conf 73), SQUEEZE_BREAKOUT BTCUSD -$6.64 at 0.01 (conf 81), "
      + "and MOMENTUM SP500 +$2.94 at 0.10 (conf 88). Gross -$416.61, expectancy "
      + "-$83.32/trade, 2 wins and 3 losses. IN R IT IS POSITIVE: -1, +2.49, -1, -1, "
      + "+2.02 = NET +1.51R. The same five fills are a disaster in dollars and fine in "
      + "R, and the entire divergence is LOT SIZE - one 0.14-lot trade lost $449.72 for "
      + "the same -1R that a 0.01-lot trade lost $6.64 for. Quote the unit. Two "
      + "positions are open. Win rate, calibration and per-setup edge still rest on one "
      + "trade per setup, below the 5-trade floor the learning engine itself requires "
      + "before it will act.",
    caveat: "The 2026-07-28 decision to trade a measured-negative edge in order to feed the "
      + "learning engine was deliberate and informed. Several of these closes only "
      + "arrived because reconciliation was repaired on 2026-08-11; before that they "
      + "sat OPEN indefinitely. The two records still disagree and BOTH have moved: the "
      + "unattributed win's setup was recorded as \"WAIT\", which updateLearning "
      + "refuses to attribute rather than invent a bucket for, so learning.json reads "
      + "1W/3L (MOMENTUM is the one win it can see) while the journal reads 2W/3L. Any "
      + "calibration claim must say which of the two it means. Note also that "
      + "MOMENTUM's +$2.94 is +2.02R on SP500 at 0.10 lots - a two-R win worth three "
      + "dollars - the same contract-size distortion the sizing note below rests on, "
      + "visible in the live record rather than in a replay.",
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
      + "2W/3L at -$416.61 gross but +1.51R; and the only trade ever taken under risk-based sizing was "
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
    // RE-BASED 2026-08-24: 4 -> 5 closed fills. MOMENTUM SP500 closed +$2.94 on
    // 2026-08-19, the first ATTRIBUTED win the learning engine can see.
    sampleAtWriting: { closedFills: 5 },
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
