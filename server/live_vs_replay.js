"use strict";
/**
 * IS THE LIVE SYSTEM BEHAVING LIKE THE THING THAT WAS MEASURED?
 *
 * Every threshold in this engine was chosen by walk-forward on replayed bars. Nothing
 * anywhere checks whether the live system then trades like that replay said it would.
 * That gap is where this project's expensive failures live: four separate hardcoded
 * copies of the confidence gate, the dashboard rendering 65 while the engine ran 70,
 * the AI filter prompt hardcoding 60, the VPS running a different strategy_settings.json
 * off the same commit, AutoTrading disabled for 11 days behind green health checks.
 * Every one of those was a live-vs-measured divergence that health checks cannot see,
 * because each component was individually fine.
 *
 * Two comparisons, because they fail independently:
 *
 *   RATE       — trades per day. Catches "the engine stopped firing" and "the engine
 *                is firing far more than the measurement that justified it". A wrong
 *                gate copy, a disarmed bridge or a dead cohort all show up here first.
 *   EXPECTANCY — realised R per trade. Catches "it fires the same amount but the
 *                trades are worse", e.g. a bad bar source or levels from the wrong
 *                timeframe.
 *
 * READ-ONLY. No writes, no gate, no confidence, no sizing. feedsTheGate is false and
 * stays false: a surface that grades the engine is exactly where "observability must
 * never alter what trades" would be easiest to break.
 *
 * THE HONEST DEFAULT IS SILENCE. With a handful of closed fills every verdict is
 * noise, so both comparisons sit behind an evidence floor and report TOO FEW TO JUDGE
 * until they clear it. A tracker that starts crying divergence at n=4 trains you to
 * ignore it by the time it is right.
 */

const fs   = require("fs");
const path = require("path");

// Below this many closed live trades, expectancy is not reported as a verdict at all.
// 20 is not a statistical guarantee — it is the point where a single outlier stops
// being the entire result. The replay baseline carries 202 closed trades for scale.
const MIN_CLOSED_FOR_EXPECTANCY = 20;

// Below this many EXPECTED trades, the Poisson rate test has no power: with an
// expectation under ~3, almost any observation is consistent with almost any rate.
const MIN_EXPECTED_FOR_RATE = 3;

// Two-sided significance for the rate test. Deliberately strict — a false alarm here
// costs more than a late one, because the response to this alarm is to go hunting
// through both boxes' configs.
const RATE_ALPHA = 0.01;

// Beyond this the Poisson terms underflow (exp(-lambda) is 0 past ~745) and the
// running sum stops meaning anything. Returning null here makes the caller report NO
// BASIS; the previous version silently truncated its sum instead, which returns a
// too-small CDF, a too-LARGE p-value, and therefore a MISSED alarm — the one failure
// direction a divergence detector must not have.
const POISSON_MAX = 100000;

/**
 * P(X <= k) for a Poisson with mean lambda.
 *
 * Iterative running term rather than a factorial per element: term_i = term_{i-1} *
 * lambda/i. That is O(k) instead of O(k^2) and needs no logs. Returns null rather
 * than a wrong number when the inputs are outside the range this can compute.
 */
function poissonCdf(k, lambda) {
  if (!(lambda > 0) || !Number.isFinite(k) || k < 0) return null;
  if (k > POISSON_MAX || lambda > POISSON_MAX) return null;
  let term = Math.exp(-lambda);
  if (!(term > 0)) return null;            // underflowed — cannot answer honestly
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
}

/** Two-sided p-value for observing `observed` when `expected` were expected. */
function poissonTwoSidedP(observed, expected) {
  if (!(expected > 0) || !Number.isFinite(observed) || observed < 0) return null;
  const cdf = observed >= expected
    ? poissonCdf(observed - 1, expected)   // want P(X >= observed) = 1 - P(X <= observed-1)
    : poissonCdf(observed, expected);      // want P(X <= observed)
  if (cdf === null) return null;
  const oneSided = observed >= expected ? 1 - cdf : cdf;
  return Math.min(1, Math.max(0, 2 * oneSided));
}

/**
 * First and last bar timestamps in a history CSV, without loading the whole file into
 * a parsed structure. `skip` is how many leading bars the replay burns as warmup, so
 * the window starts where the replay could first have traded rather than where the
 * data starts — the difference is roughly nine months and would understate the rate.
 */
function csvWindow(csvPath, skip) {
  let lines;
  try {
    if (!fs.existsSync(csvPath)) return null;
    lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  } catch (_) {
    // existsSync then readFileSync is a TOCTOU, and a directory at this path throws
    // EISDIR rather than returning anything. Either way this degrades to "no window".
    return null;
  }
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const timeIdx = header.indexOf("time");
  if (timeIdx === -1) return null;
  // Seconds, not milliseconds. A ms-stamped CSV would give a ~1.5-million-day window,
  // an expected rate of ~0, and a permanent silent TOO FEW TO JUDGE. Same floor
  // tasks/session_walkforward.cjs carries for the same reason.
  const MS_EPOCH_FLOOR = 1e11;
  const at = i => {
    const row = lines[i];
    if (!row) return null;
    const v = Number(row.split(",")[timeIdx]);
    return (Number.isFinite(v) && v > 0 && v < MS_EPOCH_FLOOR) ? v : null;
  };
  // +1 for the header row; skip bars of warmup on top of that.
  const first = at(Math.min(1 + skip, lines.length - 1));
  const last  = at(lines.length - 1);
  return (first && last && last > first) ? { first, last } : null;
}

/**
 * The calendar window the replay's trades were drawn from.
 *
 * Derived from the same CSVs tasks/_replay_mtf.cjs reads, using its own warmup rule
 * (it skips until d1Ptr >= 250), rather than being written down anywhere — a hardcoded
 * date here would silently drift the day the history is extended.
 *
 * The assets do NOT warm up together, and assuming they did was wrong by 84 days:
 * BTC's 250th daily bar lands 2022-04-22 while Gold's and SPX's land 2022-07-15,
 * because BTC trades seven days a week and the other two roughly five. Taking the
 * earliest start would put a 1556-day denominator under a population where two of the
 * three assets were only exposed for 1470 — understating the rate by ~3.6% in exactly
 * the direction that hides a "stopped firing" fault.
 *
 * The baseline JSON pools its trades and does not attribute them per asset, so no
 * denominator here is exact. `exposureDays` is the MEAN per-asset exposure, which is
 * the right denominator for a pooled count of per-asset events. from/to are reported
 * separately for display and are the true outer bounds.
 */
function replayWindow(historyDir, symbols) {
  const D1_WARMUP_BARS = 250;
  let first = null, last = null;
  const spans = [];
  for (const symbol of symbols) {
    const d1 = csvWindow(path.join(historyDir, `${symbol}_D1.csv`), D1_WARMUP_BARS);
    if (!d1) continue;
    spans.push((d1.last - d1.first) / 86400);
    if (first === null || d1.first < first) first = d1.first;
    if (last === null || d1.last > last) last = d1.last;
  }
  if (first === null || last === null || spans.length === 0) return null;
  const exposureDays = spans.reduce((a, d) => a + d, 0) / spans.length;
  if (!(exposureDays > 0)) return null;
  return {
    fromEpoch: first,
    toEpoch: last,
    spanDays: (last - first) / 86400,
    exposureDays,
    assetsCovered: spans.length,
  };
}

/** ISO date for an epoch-seconds value, or null when it is out of range. Date's
 *  toISOString throws a RangeError rather than returning anything useful. */
function isoDay(epochSeconds) {
  try {
    const d = new Date(epochSeconds * 1000);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch (_) { return null; }
}

/**
 * Live closed trades, scored the way the rest of this project scores them: realised R
 * derived from PRICES, never from the stored `rr` field. That field is the signal's
 * PLAN — what the setup intended — and reading it as an outcome is how "WAIT" once
 * became the best-performing setup in the table.
 */
function summariseLive(journal, realizedRFromPrices) {
  const rows = Array.isArray(journal) ? journal : [];

  // OPENED is the rate question's numerator, and deliberately NOT the closed count.
  // A trade that has fired but not yet resolved still fired. Counting closes on the
  // live side while the replay side counts firings would report "TRADING TOO LITTLE"
  // for a gate that is working perfectly — and this repo has a standing bug where a
  // close can be missed entirely and a position stays OPEN in the journal forever,
  // which would make that false alarm permanent.
  let opened = 0;
  let firstOpenEpoch = null;
  for (const t of rows) {
    const ms = Date.parse(t?.openTime ?? "");
    if (!Number.isFinite(ms)) continue;
    opened++;
    const seconds = ms / 1000;
    if (firstOpenEpoch === null || seconds < firstOpenEpoch) firstOpenEpoch = seconds;
  }

  const closed = rows.filter(t => t && t.status === "CLOSED");
  const stillOpen = rows.filter(t => t && t.status === "OPEN").length;

  const scored = [];
  let unscorable = 0;
  for (const t of closed) {
    const r = realizedRFromPrices(t.direction, t.entry, t.sl, t.closePrice);
    if (r === null) { unscorable++; continue; }
    scored.push({ r, pnl: typeof t.pnl === "number" ? t.pnl : null });
  }

  const wins = scored.filter(s => s.r > 0).length;
  const totalR = scored.reduce((a, s) => a + s.r, 0);

  return {
    opened,
    stillOpen,
    closed: scored.length,
    unscorable,
    wins,
    wr: scored.length ? (wins / scored.length) * 100 : null,
    totalR: scored.length ? parseFloat(totalR.toFixed(3)) : null,
    rpt: scored.length ? parseFloat((totalR / scored.length).toFixed(4)) : null,
    firstOpenEpoch,
  };
}

/**
 * Build the comparison. Never throws: every failure becomes an `available:false` with
 * a reason, because a health surface that 500s is a health surface nobody reads.
 */
function buildLiveVsReplay({ journal, analysisPath, historyDir, symbols, realizedRFromPrices, nowEpoch }) {
  const now = Number.isFinite(nowEpoch) ? nowEpoch : Math.floor(Date.now() / 1000);
  const out = {
    generatedAt: new Date(now * 1000).toISOString(),
    available: false,
    reason: null,
    feedsTheGate: false,
    note: "Read-only. Compares the live journal against the walk-forward that " +
          "justified the current config. Changes no threshold and admits no signal.",
  };

  let analysis;
  try {
    if (!fs.existsSync(analysisPath)) {
      out.reason = `no replay baseline on disk at ${path.basename(analysisPath)} — ` +
                   `run node tasks/session_walkforward.cjs --by setup to produce one`;
      return out;
    }
    analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  } catch (e) {
    out.reason = `replay baseline unreadable: ${e.message}`;
    return out;
  }

  const baseline = analysis?.atLiveGate?.baseline;
  const costR    = Number(analysis?.basis?.costR);
  const gate     = analysis?.basis?.gate ?? null;
  if (!baseline || !Number.isFinite(baseline.closed) || !Number.isFinite(baseline.rpt)) {
    out.reason = "replay baseline is missing atLiveGate.baseline — the analysis file " +
                 "changed shape; fix this reader rather than reporting a number it did not measure";
    return out;
  }

  // FIRED, not scored. atLiveGate.trades counts every trade the replay opened at this
  // gate; baseline.closed drops the EXPIRED ones — trades that fired and resolved at
  // the last bar rather than at a stop or target. That is the correct denominator for
  // P&L and the WRONG one for a rate, and using it understated the expected firing
  // rate by 23% (202 vs 261) in exactly the direction that hides a stopped engine.
  const replayFired = Number.isFinite(analysis?.atLiveGate?.trades)
    ? analysis.atLiveGate.trades : null;

  let window = null;
  try { window = replayWindow(historyDir, symbols); } catch (_) { window = null; }
  const live = summariseLive(journal, realizedRFromPrices);

  // The replay charges costR on EVERY closed trade (wins pay rr - cost, losses pay
  // 1 + cost), so its gross expectancy is exactly rpt + costR. The live account is a
  // DEMO that fills stops at the exact stop price with no slippage and no spread, so
  // live R carries no cost at all. Comparing the two directly would hand live a free
  // advantage of costR per trade. Gross-vs-gross is the only like-for-like available.
  //
  // That identity holds only while every closed replay trade is a WIN or a LOSS. With
  // the trailing ladder armed the harness also emits TRAILED, which counts in `closed`
  // but contributes to neither side of the sum, and rptGross would be overstated. The
  // baseline does not record the ladder state today, so this refuses only when the
  // field appears and says it was on — forward-compatible rather than silently wrong.
  const trailLadderOn = analysis?.basis?.trailLadder === true;
  const replayRptGross = (Number.isFinite(costR) && !trailLadderOn)
    ? parseFloat((baseline.rpt + costR).toFixed(4)) : null;

  const replayPerDay = (window && replayFired !== null && window.exposureDays > 0)
    ? parseFloat((replayFired / window.exposureDays).toFixed(5)) : null;

  out.available = true;
  out.gate = gate;
  out.replay = {
    source: path.basename(analysisPath),
    generatedAt: analysis.generatedAt ?? null,
    fired: replayFired,
    closed: baseline.closed,
    expiredNotScored: replayFired !== null ? replayFired - baseline.closed : null,
    wr: Number.isFinite(baseline.wr) ? parseFloat(baseline.wr.toFixed(1)) : null,
    rptNetOfCost: parseFloat(baseline.rpt.toFixed(4)),
    costR: Number.isFinite(costR) ? costR : null,
    rptGross: replayRptGross,
    window: window ? {
      from: isoDay(window.fromEpoch),
      to:   isoDay(window.toEpoch),
      spanDays: Math.round(window.spanDays),
      exposureDays: Math.round(window.exposureDays),
      assetsCovered: window.assetsCovered,
      note: "exposureDays is the MEAN per-asset exposure and is the rate denominator; " +
            "the assets do not warm up together (BTC trades 7 days a week, Gold and " +
            "SPX about 5), so spanDays would flatter a quiet engine.",
    } : null,
    tradesPerDay: replayPerDay,
  };

  const liveDays = live.firstOpenEpoch ? (now - live.firstOpenEpoch) / 86400 : null;
  out.live = {
    opened: live.opened,
    stillOpen: live.stillOpen,
    closed: live.closed,
    unscorable: live.unscorable,
    wins: live.wins,
    wr: live.wr === null ? null : parseFloat(live.wr.toFixed(1)),
    totalR: live.totalR,
    rptGross: live.rpt,
    since: live.firstOpenEpoch ? isoDay(live.firstOpenEpoch) : null,
    days: liveDays === null ? null : Math.round(liveDays * 10) / 10,
    tradesPerDay: liveDays > 0 ? parseFloat((live.opened / liveDays).toFixed(5)) : null,
    costNote: "Demo account: stops currently fill at the exact stop price, so these " +
              "carry no slippage and no spread, and are compared against the replay's " +
              "GROSS expectancy. This stops being true if lot size rises enough for " +
              "the bridge's 1R partial to clear volume_min, because a partialled trade " +
              "measures its remainder against full risk and the replay never partials.",
    wrNote: "Live wr counts every scorable close; replay wr excludes EXPIRED from its " +
            "denominator. Reported for context, never differenced.",
  };

  // ── rate ────────────────────────────────────────────────────────────────────
  // Firings on BOTH sides: replay trades opened vs live trades opened. Comparing
  // replay firings against live CLOSES would count an open position as a missing
  // trade and cry "TRADING TOO LITTLE" at a healthy engine.
  const expected = (replayPerDay !== null && liveDays > 0) ? replayPerDay * liveDays : null;
  if (expected === null) {
    out.rate = { verdict: "NO BASIS", detail: "replay window or live start date unavailable" };
  } else if (expected < MIN_EXPECTED_FOR_RATE) {
    const daysNeeded = Math.ceil((MIN_EXPECTED_FOR_RATE / replayPerDay) - liveDays);
    out.rate = {
      verdict: "TOO FEW TO JUDGE",
      basis: "trades opened, both sides",
      expected: parseFloat(expected.toFixed(2)),
      observed: live.opened,
      detail: `only ${expected.toFixed(1)} trades expected so far; the test has no ` +
              `power below ${MIN_EXPECTED_FOR_RATE}.` +
              (Number.isFinite(daysNeeded) && daysNeeded > 0
                ? ` Needs about ${daysNeeded} more days.` : ""),
    };
  } else {
    const p = poissonTwoSidedP(live.opened, expected);
    const ratio = expected > 0 ? live.opened / expected : null;
    const flagged = p !== null && p < RATE_ALPHA;
    out.rate = {
      verdict: p === null ? "NO BASIS"
        : flagged ? (live.opened < expected ? "TRADING TOO LITTLE" : "TRADING TOO MUCH")
        : "CONSISTENT WITH REPLAY",
      basis: "trades opened, both sides",
      expected: parseFloat(expected.toFixed(2)),
      observed: live.opened,
      ratio: ratio === null ? null : parseFloat(ratio.toFixed(2)),
      pValue: p === null ? null : parseFloat(p.toFixed(4)),
      alpha: RATE_ALPHA,
      detail: p === null
        ? "Poisson test out of computable range — no verdict rather than a wrong one."
        : flagged
        ? "Live firing rate differs from the measured rate by more than chance. Check " +
          "both boxes' confidence gate, autoMode per account, and cohort reachability " +
          "before assuming the market changed."
        : "Live firing count is within Poisson noise of the replayed rate.",
    };
  }

  // ── expectancy ──────────────────────────────────────────────────────────────
  // The two reasons this cannot be answered are different and must not share a
  // message: one is "wait for more trades", the other is "the baseline file changed
  // and nobody can compute a cost-comparable number". Reporting a 200-trade sample as
  // "200 of 20 needed" is the kind of self-contradiction that gets a page ignored.
  if (replayRptGross === null) {
    out.expectancy = {
      verdict: "NO BASIS",
      liveRptGross: live.rpt,
      replayRptGross: null,
      have: live.closed,
      detail: trailLadderOn
        ? "The baseline was produced with the trailing ladder armed, so its TRAILED " +
          "outcomes break the rpt + costR identity and a gross figure cannot be derived."
        : "The baseline carries no usable basis.costR, so the replay's gross expectancy " +
          "cannot be derived and a like-for-like comparison is impossible.",
    };
  } else if (live.closed < MIN_CLOSED_FOR_EXPECTANCY) {
    out.expectancy = {
      verdict: "TOO FEW TO JUDGE",
      liveRptGross: live.rpt,
      replayRptGross,
      needed: MIN_CLOSED_FOR_EXPECTANCY,
      have: live.closed,
      detail: `${live.closed} of ${MIN_CLOSED_FOR_EXPECTANCY} closed trades needed. ` +
              `Any difference at this sample is one trade wearing a verdict's clothes.`,
    };
  } else {
    const delta = parseFloat((live.rpt - replayRptGross).toFixed(4));
    out.expectancy = {
      verdict: delta >= 0 ? "AT OR ABOVE REPLAY" : "BELOW REPLAY",
      liveRptGross: live.rpt,
      replayRptGross,
      deltaR: delta,
      have: live.closed,
      detail: "Live realised R per trade against the replay's gross expectancy. " +
              "Derived from prices, never from the journal's stored rr field.",
    };
  }

  out.blocking = live.closed < MIN_CLOSED_FOR_EXPECTANCY
    ? `sample size — ${live.closed} closed fills, ${MIN_CLOSED_FOR_EXPECTANCY} needed before ` +
      `expectancy means anything`
    : null;

  return out;
}

module.exports = {
  buildLiveVsReplay,
  // Exported for tests: these are the pieces worth checking independently.
  poissonTwoSidedP,
  replayWindow,
  summariseLive,
  MIN_CLOSED_FOR_EXPECTANCY,
  MIN_EXPECTED_FOR_RATE,
};
