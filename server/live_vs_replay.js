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

/** P(X = k) for a Poisson with mean lambda, computed in log space so a large lambda
 *  cannot overflow the factorial. */
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** P(X <= k). Capped so a pathological lambda cannot spin. */
function poissonCdf(k, lambda) {
  let sum = 0;
  const limit = Math.min(k, 100000);
  for (let i = 0; i <= limit; i++) sum += poissonPmf(i, lambda);
  return Math.min(1, sum);
}

/** Two-sided p-value for observing `observed` when `expected` were expected. */
function poissonTwoSidedP(observed, expected) {
  if (!(expected > 0)) return null;
  const p = observed >= expected
    ? 1 - poissonCdf(observed - 1, expected)   // P(X >= observed)
    : poissonCdf(observed, expected);          // P(X <= observed)
  return Math.min(1, Math.max(0, 2 * p));
}

/**
 * First and last bar timestamps in a history CSV, without loading the whole file into
 * a parsed structure. `skip` is how many leading bars the replay burns as warmup, so
 * the window starts where the replay could first have traded rather than where the
 * data starts — the difference is roughly nine months and would understate the rate.
 */
function csvWindow(csvPath, skip) {
  if (!fs.existsSync(csvPath)) return null;
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const timeIdx = header.indexOf("time");
  if (timeIdx === -1) return null;
  const at = i => {
    const row = lines[i];
    if (!row) return null;
    const v = Number(row.split(",")[timeIdx]);
    return Number.isFinite(v) ? v : null;
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
 * The three assets warm up within days of each other, so the pooled window is taken as
 * the earliest start and the latest end. That is an approximation of at most a few
 * days across a four-year window; it is named here rather than hidden.
 */
function replayWindow(historyDir, symbols) {
  const D1_WARMUP_BARS = 250;
  let first = null, last = null;
  for (const symbol of symbols) {
    const d1 = csvWindow(path.join(historyDir, `${symbol}_D1.csv`), D1_WARMUP_BARS);
    if (!d1) continue;
    if (first === null || d1.first < first) first = d1.first;
    if (last === null || d1.last > last) last = d1.last;
  }
  if (first === null || last === null) return null;
  return { fromEpoch: first, toEpoch: last, days: (last - first) / 86400 };
}

/**
 * Live closed trades, scored the way the rest of this project scores them: realised R
 * derived from PRICES, never from the stored `rr` field. That field is the signal's
 * PLAN — what the setup intended — and reading it as an outcome is how "WAIT" once
 * became the best-performing setup in the table.
 */
function summariseLive(journal, realizedRFromPrices) {
  const closed = (Array.isArray(journal) ? journal : [])
    .filter(t => t && t.status === "CLOSED");

  const scored = [];
  let unscorable = 0;
  for (const t of closed) {
    const r = realizedRFromPrices(t.direction, t.entry, t.sl, t.closePrice);
    if (r === null) { unscorable++; continue; }
    scored.push({ r, pnl: typeof t.pnl === "number" ? t.pnl : null });
  }

  const wins = scored.filter(s => s.r > 0).length;
  const totalR = scored.reduce((a, s) => a + s.r, 0);

  // Earliest OPEN time across the whole journal, closed or not: the live system has
  // been exposed since its first fill, not since its first CLOSE.
  let firstOpenEpoch = null;
  for (const t of (Array.isArray(journal) ? journal : [])) {
    const ms = Date.parse(t?.openTime ?? "");
    if (!Number.isFinite(ms)) continue;
    if (firstOpenEpoch === null || ms / 1000 < firstOpenEpoch) firstOpenEpoch = ms / 1000;
  }

  return {
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
                   `run node tasks/setup_walkforward.cjs to produce one`;
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

  const window = replayWindow(historyDir, symbols);
  const live   = summariseLive(journal, realizedRFromPrices);

  // The replay charges costR on EVERY closed trade (wins pay rr - cost, losses pay
  // 1 + cost), so its gross expectancy is exactly rpt + costR. The live account is a
  // DEMO that fills stops at the exact stop price with no slippage and no spread, so
  // live R carries no cost at all. Comparing the two directly would hand live a free
  // advantage of costR per trade. Gross-vs-gross is the only like-for-like available.
  const replayRptGross = Number.isFinite(costR)
    ? parseFloat((baseline.rpt + costR).toFixed(4)) : null;

  out.available = true;
  out.gate = gate;
  out.replay = {
    source: path.basename(analysisPath),
    generatedAt: analysis.generatedAt ?? null,
    closed: baseline.closed,
    wr: Number.isFinite(baseline.wr) ? parseFloat(baseline.wr.toFixed(1)) : null,
    rptNetOfCost: parseFloat(baseline.rpt.toFixed(4)),
    costR: Number.isFinite(costR) ? costR : null,
    rptGross: replayRptGross,
    window: window ? {
      from: new Date(window.fromEpoch * 1000).toISOString().slice(0, 10),
      to:   new Date(window.toEpoch   * 1000).toISOString().slice(0, 10),
      days: Math.round(window.days),
    } : null,
    tradesPerDay: window && window.days > 0
      ? parseFloat((baseline.closed / window.days).toFixed(5)) : null,
  };

  const liveDays = live.firstOpenEpoch ? (now - live.firstOpenEpoch) / 86400 : null;
  out.live = {
    closed: live.closed,
    unscorable: live.unscorable,
    wins: live.wins,
    wr: live.wr === null ? null : parseFloat(live.wr.toFixed(1)),
    totalR: live.totalR,
    rptGross: live.rpt,
    since: live.firstOpenEpoch
      ? new Date(live.firstOpenEpoch * 1000).toISOString().slice(0, 10) : null,
    days: liveDays === null ? null : Math.round(liveDays * 10) / 10,
    tradesPerDay: liveDays > 0 ? parseFloat((live.closed / liveDays).toFixed(5)) : null,
    costNote: "Demo account: stops fill at the exact stop price, so these carry no " +
              "slippage and no spread. Compared against the replay's GROSS expectancy.",
  };

  // ── rate ────────────────────────────────────────────────────────────────────
  const expected = (out.replay.tradesPerDay !== null && liveDays > 0)
    ? out.replay.tradesPerDay * liveDays : null;
  if (expected === null) {
    out.rate = { verdict: "NO BASIS", detail: "replay window or live start date unavailable" };
  } else if (expected < MIN_EXPECTED_FOR_RATE) {
    out.rate = {
      verdict: "TOO FEW TO JUDGE",
      expected: parseFloat(expected.toFixed(2)),
      observed: live.closed,
      detail: `only ${expected.toFixed(1)} trades expected so far; the test has no ` +
              `power below ${MIN_EXPECTED_FOR_RATE}. Needs about ` +
              `${Math.ceil((MIN_EXPECTED_FOR_RATE / out.replay.tradesPerDay) - liveDays)} more days.`,
    };
  } else {
    const p = poissonTwoSidedP(live.closed, expected);
    const ratio = expected > 0 ? live.closed / expected : null;
    out.rate = {
      verdict: p !== null && p < RATE_ALPHA
        ? (live.closed < expected ? "TRADING TOO LITTLE" : "TRADING TOO MUCH")
        : "CONSISTENT WITH REPLAY",
      expected: parseFloat(expected.toFixed(2)),
      observed: live.closed,
      ratio: ratio === null ? null : parseFloat(ratio.toFixed(2)),
      pValue: p === null ? null : parseFloat(p.toFixed(4)),
      alpha: RATE_ALPHA,
      detail: p !== null && p < RATE_ALPHA
        ? "Live trade rate differs from the measured rate by more than chance. Check " +
          "both boxes' confidence gate, autoMode per account, and cohort reachability " +
          "before assuming the market changed."
        : "Live trade count is within Poisson noise of the replayed rate.",
    };
  }

  // ── expectancy ──────────────────────────────────────────────────────────────
  if (live.closed < MIN_CLOSED_FOR_EXPECTANCY || replayRptGross === null) {
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
