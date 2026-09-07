'use strict';
/**
 * Does getLearningBoost measure the right thing?
 *
 * WHY THIS EXISTS. On 2026-09-07 MOMENTUM became the first setup ever to cross
 * LEARNING_MIN_TRADES, so getLearningBoost went non-zero on the live trade path for
 * the first time in this system's life: 3W-2L is a 60% win rate, which the live curve
 * turns into +3 confidence, applied at server/index.js:3538-3540 ahead of a gate of 70.
 * The same setup carries totalPnl -170.32 and /api/checksystem labels it
 * PAYOFF-NEGATIVE. The engine calls a setup payoff-negative on one surface and moves
 * every one of its signals three points nearer the gate in the scorer, in the same
 * process.
 *
 * evidence_register.js:364-366 wrote that exact case down as hypothetical - "at 5
 * closed trades a 60% win rate would hand it a POSITIVE boost while it loses money".
 * It is no longer hypothetical, which is the whole reason to measure rather than argue.
 *
 * WHAT IT DOES NOT DO. It does not edit the engine, propose an edit, or write anything
 * the engine reads. It extracts getLearningBoost FROM server/index.js and runs it
 * against variants that differ in ONE respect - the rate fed into the curve - so the
 * comparison cannot drift from the live function the way a hand-copied formula would.
 * Read-only over journal.json. No gate, threshold, size or order path is reachable
 * from here.
 *
 * THE THREE SIGNALS, one curve, no new tuning constants:
 *
 *   winRate    wins / total                        <- what the engine uses today
 *   rRate      sumWinR / (sumWinR + |sumLossR|)    <- payoff-weighted, in R
 *   cashRate   sumWinPnl / (sumWinPnl + |sumLossPnl|)
 *
 * All three are win-rate-shaped: they live in [0,1], they equal each other exactly
 * when every win is +1R and every loss is -1R, and each is 0.5 at break-even. So the
 * SAME curve consumes all three and any difference in the output is a difference in
 * the question asked, not in the arithmetic answering it. That property is asserted in
 * the selftest rather than claimed here.
 *
 * WALK-FORWARD, NOT FIT. For the i-th closed trade of a setup the boost in force is
 * computed from trades 0..i-1 only. A boost that "knew" the trade it was scoring would
 * report whatever we hoped.
 *
 * ON SAMPLE. Nine closed fills exist, five of them MOMENTUM. That settles nothing and
 * the report says so in its own verdict line rather than in a footnote. What it CAN do
 * is state, exactly and today, whether the three signals disagree and by how much -
 * because if they agree there is nothing here to decide, and if they disagree the
 * direction of the disagreement is the thing worth knowing before the boost grows.
 *
 * Usage:
 *   node tasks/learning_boost_walkforward.cjs
 *   node tasks/learning_boost_walkforward.cjs --selftest
 *   node tasks/learning_boost_walkforward.cjs --json
 */

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

const ROOT         = path.join(__dirname, "..");
const INDEX_PATH   = path.join(ROOT, "server", "index.js");
const JOURNAL_PATH = path.join(ROOT, "server", "journal.json");

const { loadServerScorer } = require("./sizing_trigger.cjs");

// ── the live curve, lifted out of server/index.js ───────────────────────────────
//
// Extracted, never copied, for the reason sizing_trigger.cjs states about
// realizedRFromPrices: a copy is correct on the day it is written and silently wrong
// afterwards, and this harness exists precisely to say something about the function the
// engine runs. If the extraction fails this throws rather than falling back to a copy -
// a harness that quietly measures its own reimplementation is worse than no harness.
function loadLiveBoostCurve() {
  const source = fs.readFileSync(INDEX_PATH, "utf8");

  const constants = {};
  for (const name of ["LEARNING_MIN_TRADES", "LEARNING_BOOST_CAP",
                      "LEARNING_BOOST_SPAN", "LEARNING_SHRINK_PSEUDO_TRADES"]) {
    const found = source.match(new RegExp("const\\s+" + name + "\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*;"));
    if (!found) throw new Error("could not read " + name + " from server/index.js");
    constants[name] = Number(found[1]);
  }

  const start = source.indexOf("function getLearningBoost(");
  if (start === -1) throw new Error("could not find getLearningBoost in server/index.js");
  let depth = 0, end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error("getLearningBoost in server/index.js is unbalanced");
  const body = source.slice(start, end);

  // The engine's function reads a `learning.setupStats` table and a `setup` name. The
  // sandbox supplies a one-row table so the extracted body runs unmodified: changing it
  // to take (wins, losses) would be an edit, and an edited function is a copy again.
  const sandbox = { learning: { setupStats: {} }, ...constants };
  vm.createContext(sandbox);
  vm.runInContext(body + "\nthis.__boost = getLearningBoost;", sandbox, { timeout: 2000 });
  if (typeof sandbox.__boost !== "function") throw new Error("extracted getLearningBoost is not callable");

  // The curve, addressed by a RATE rather than by a win/loss pair. The engine derives
  // its rate as wins/total, so feeding it integer wins/losses that produce the desired
  // rate reproduces the live path exactly for winRate and reuses it verbatim for the
  // other two. Scaled by a large denominator so any rate in [0,1] is representable and
  // the shrink prior keeps its documented meaning of "pseudo-trades against volume".
  function curve(rate, total) {
    const wins   = rate * total;
    const losses = total - wins;
    sandbox.learning.setupStats.X = { wins, losses };
    return sandbox.__boost("X");
  }
  return { curve, constants };
}

// ── the three rates ─────────────────────────────────────────────────────────────
//
// Each is a share-of-the-good-side ratio, which is what makes them commensurable: with
// every outcome at +/-1R the R and cash ratios collapse onto the plain win rate, so a
// divergence is always attributable to payoff dispersion and never to the mapping.
function ratesFrom(trades) {
  const wins   = trades.filter(t => t.won).length;
  const losses = trades.length - wins;

  const sumWinR   = trades.filter(t =>  t.won).reduce((a, t) => a + Math.abs(t.r || 0), 0);
  const sumLossR  = trades.filter(t => !t.won).reduce((a, t) => a + Math.abs(t.r || 0), 0);
  const sumWinPnl = trades.filter(t =>  t.won).reduce((a, t) => a + Math.abs(t.pnl || 0), 0);
  const sumLossPnl= trades.filter(t => !t.won).reduce((a, t) => a + Math.abs(t.pnl || 0), 0);

  // A zero denominator means no magnitude on either side - not a 0% rate. Falling back
  // to the win rate keeps the variant defined without inventing an outcome.
  const ratio = (good, bad, fallback) => (good + bad) > 0 ? good / (good + bad) : fallback;
  const winRate = trades.length ? wins / trades.length : 0.5;

  return {
    total: trades.length, wins, losses,
    winRate,
    rRate:    ratio(sumWinR,   sumLossR,   winRate),
    cashRate: ratio(sumWinPnl, sumLossPnl, winRate),
    netR:     trades.reduce((a, t) => a + (t.r || 0), 0),
    netPnl:   trades.reduce((a, t) => a + (t.pnl || 0), 0),
  };
}

// ── the journal, as closed fills with a realized R apiece ───────────────────────
function loadClosedTrades() {
  const scorer = loadServerScorer(ROOT);
  const raw = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8"));
  const rows = Array.isArray(raw) ? raw : (raw.journal || raw.trades || []);

  const closed = rows.filter(t => t.status === "CLOSED" && t.closeTime)
    .sort((a, b) => String(a.closeTime).localeCompare(String(b.closeTime)));

  const skipped = [];
  const trades = [];
  for (const t of closed) {
    const r = scorer(t.direction, t.entry, t.sl, t.closePrice);
    if (r === null) { skipped.push({ ticket: t.ticket, why: "no realizable R from its own prices" }); continue; }
    trades.push({
      ticket: t.ticket, closeTime: t.closeTime, symbol: t.symbol,
      setup: t.setup || "UNKNOWN",
      // The engine counts a win by P&L (updateLearning is driven off the closed row's
      // pnl), so this must too, or the walk-forward would be scoring a different
      // function from the one it extracted.
      won: Number(t.pnl) > 0,
      pnl: Number(t.pnl) || 0,
      r,
      confidence: Number.isFinite(t.confidence) ? t.confidence : null,
    });
  }
  return { trades, skipped };
}

// ── the walk-forward ────────────────────────────────────────────────────────────
function walkForward(trades, curve) {
  const bySetup = {};
  for (const t of trades) (bySetup[t.setup] = bySetup[t.setup] || []).push(t);

  const steps = [];
  for (const [setup, list] of Object.entries(bySetup)) {
    for (let i = 0; i < list.length; i++) {
      const prior = list.slice(0, i);              // strictly before - no lookahead
      const rates = ratesFrom(prior);
      steps.push({
        setup, index: i + 1, ofN: list.length,
        closeTime: list[i].closeTime, symbol: list[i].symbol,
        priorTrades: prior.length,
        boostWinRate: curve(rates.winRate,  prior.length),
        boostRRate:   curve(rates.rRate,    prior.length),
        boostCashRate:curve(rates.cashRate, prior.length),
        rates,
        thisTrade: { won: list[i].won, r: list[i].r, pnl: list[i].pnl, confidence: list[i].confidence },
      });
    }
  }

  // And the state as it stands NOW - the boost each variant has in force for the NEXT
  // signal of each setup. This is the live question; the steps above are its history.
  const now = Object.entries(bySetup).map(([setup, list]) => {
    const rates = ratesFrom(list);
    return {
      setup, closed: list.length, rates,
      boostWinRate:  curve(rates.winRate,  list.length),
      boostRRate:    curve(rates.rRate,    list.length),
      boostCashRate: curve(rates.cashRate, list.length),
    };
  }).sort((a, b) => b.closed - a.closed);

  return { steps, now };
}

// ── selftest ────────────────────────────────────────────────────────────────────
function selftest() {
  const failures = [];
  const ok = (name, cond, detail) => { if (!cond) failures.push(name + (detail ? " - " + detail : "")); };

  const { curve, constants } = loadLiveBoostCurve();

  ok("constants extracted", constants.LEARNING_MIN_TRADES === 5
     && constants.LEARNING_BOOST_CAP === 15 && constants.LEARNING_BOOST_SPAN === 30,
     JSON.stringify(constants));

  // The worked examples in getLearningBoost's own docblock. If the extraction were
  // subtly wrong these are what would catch it.
  const cases = [
    [0, 5, -5], [1, 4, -3], [2, 3, -1], [0, 20, -10], [0, 50, -12],
    [3, 2, 3], [5, 0, 15], [45, 5, 12],
  ];
  for (const [w, l, expected] of cases) {
    const got = curve(w / (w + l), w + l);
    ok(`docblock case ${w}W/${l}L`, got === expected, `expected ${expected}, got ${got}`);
  }

  // Below the floor the curve must be silent whatever the rate says.
  ok("floor holds", curve(1.0, constants.LEARNING_MIN_TRADES - 1) === 0);

  // THE COMMENSURABILITY CLAIM, asserted rather than asserted-in-prose: at +/-1R with
  // equal cash the three rates must be identical, so any later divergence is payoff
  // dispersion and nothing else.
  const flat = [
    { won: true,  r:  1, pnl:  100 }, { won: true,  r:  1, pnl:  100 },
    { won: true,  r:  1, pnl:  100 }, { won: false, r: -1, pnl: -100 },
    { won: false, r: -1, pnl: -100 },
  ];
  const fr = ratesFrom(flat);
  ok("three rates agree on flat outcomes",
     Math.abs(fr.winRate - fr.rRate) < 1e-9 && Math.abs(fr.winRate - fr.cashRate) < 1e-9,
     JSON.stringify(fr));

  // And they must diverge when they should: same 3W-2L, losses three times the size.
  const skewed = [
    { won: true,  r:  1, pnl:  100 }, { won: true,  r:  1, pnl:  100 },
    { won: true,  r:  1, pnl:  100 }, { won: false, r: -3, pnl: -300 },
    { won: false, r: -3, pnl: -300 },
  ];
  const sr = ratesFrom(skewed);
  ok("rates diverge on skewed payoffs", sr.winRate === 0.6 && sr.rRate < 0.5 && sr.cashRate < 0.5,
     JSON.stringify(sr));

  // No division by zero when a side is empty.
  const allWins = ratesFrom([{ won: true, r: 2, pnl: 50 }]);
  ok("all-wins rate is finite", Number.isFinite(allWins.rRate) && allWins.rRate === 1);
  ok("empty set is neutral", ratesFrom([]).winRate === 0.5);

  // Walk-forward must never see the trade it is scoring.
  const wf = walkForward([
    { setup: "T", closeTime: "1", symbol: "X", won: true,  r: 1, pnl: 1, confidence: 70 },
    { setup: "T", closeTime: "2", symbol: "X", won: false, r: -1, pnl: -1, confidence: 70 },
  ], curve);
  ok("first step has no prior", wf.steps[0].priorTrades === 0);
  ok("second step has exactly one prior", wf.steps[1].priorTrades === 1);

  console.log(failures.length ? "SELFTEST FAILURES:\n  " + failures.join("\n  ")
                              : `ALL CHECKS PASSED (${cases.length + 8} assertions)`);
  return failures.length === 0;
}

// ── report ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) process.exit(selftest() ? 0 : 1);

  const { curve, constants } = loadLiveBoostCurve();
  const { trades, skipped } = loadClosedTrades();
  const { steps, now } = walkForward(trades, curve);

  const disagreements = now.filter(s => s.boostWinRate !== s.boostRRate || s.boostWinRate !== s.boostCashRate);
  const live = now.filter(s => s.closed >= constants.LEARNING_MIN_TRADES);

  const result = {
    generatedAt: new Date().toISOString(),
    extractedFrom: "server/index.js getLearningBoost",
    constants,
    closedTrades: trades.length,
    skipped,
    setupsAtOrOverFloor: live.map(s => s.setup),
    now, steps,
    feedsTheGate: false,
  };

  if (args.includes("--json")) { console.log(JSON.stringify(result, null, 2)); return; }

  const R = n => (n >= 0 ? "+" : "") + n.toFixed(3);
  console.log("=".repeat(100));
  console.log("  getLearningBoost - THREE SIGNALS, ONE CURVE, WALKED FORWARD");
  console.log("  extracted from server/index.js  |  read-only  |  feeds no gate");
  console.log("=".repeat(100));
  console.log(`  closed fills: ${trades.length}   floor: ${constants.LEARNING_MIN_TRADES}   `
            + `cap: +/-${constants.LEARNING_BOOST_CAP}   span: ${constants.LEARNING_BOOST_SPAN}`);
  if (skipped.length) console.log(`  skipped ${skipped.length}: ` + skipped.map(s => s.ticket + " (" + s.why + ")").join(", "));

  console.log("\n  BOOST IN FORCE FOR THE NEXT SIGNAL OF EACH SETUP");
  console.log("  " + "-".repeat(96));
  console.log("  setup              n   win%    netR      net$      | winRate  rRate  cash$   <- boost each would apply");
  for (const s of now) {
    const flag = s.closed >= constants.LEARNING_MIN_TRADES ? " LIVE" : "";
    console.log("  " + s.setup.padEnd(18)
      + String(s.closed).padStart(2)
      + String(Math.round(s.rates.winRate * 100) + "%").padStart(7)
      + R(s.rates.netR).padStart(9)
      + (s.rates.netPnl >= 0 ? "+" : "") + s.rates.netPnl.toFixed(2).padStart(9)
      + "   |" + String(s.boostWinRate).padStart(7)
      + String(s.boostRRate).padStart(7)
      + String(s.boostCashRate).padStart(7) + flag);
  }

  console.log("\n  WALK-FORWARD - the boost that WOULD have been in force at each close");
  console.log("  " + "-".repeat(96));
  console.log("  setup              #  closed      symbol    prior | winRate  rRate  cash$ | this trade");
  for (const st of steps) {
    console.log("  " + st.setup.padEnd(18)
      + String(st.index) + "/" + String(st.ofN) + "  "
      + String(st.closeTime).slice(0, 10) + "  "
      + String(st.symbol || "").padEnd(8)
      + String(st.priorTrades).padStart(6)
      + " |" + String(st.boostWinRate).padStart(7)
      + String(st.boostRRate).padStart(7)
      + String(st.boostCashRate).padStart(7)
      + " | " + (st.thisTrade.won ? "WIN " : "LOSS") + " " + R(st.thisTrade.r)
      + (st.thisTrade.confidence != null ? "  conf " + st.thisTrade.confidence : ""));
  }

  console.log("\n  VERDICT");
  console.log("  " + "-".repeat(96));
  if (!live.length) {
    console.log("  No setup has reached the floor, so every boost is 0 and there is nothing to choose between.");
  } else {
    for (const s of live) {
      const agree = s.boostWinRate === s.boostRRate && s.boostWinRate === s.boostCashRate;
      console.log(`  ${s.setup}: live boost ${s.boostWinRate >= 0 ? "+" : ""}${s.boostWinRate}`
        + `, R-weighted ${s.boostRRate >= 0 ? "+" : ""}${s.boostRRate}`
        + `, cash ${s.boostCashRate >= 0 ? "+" : ""}${s.boostCashRate}`
        + (agree ? "  -> ALL THREE AGREE" : "  -> THEY DISAGREE"));
    }
  }
  console.log(`\n  ${disagreements.length} of ${now.length} setup(s) show a disagreement between the three signals.`);
  console.log("\n  ON SAMPLE. This is " + trades.length + " closed fills. A walk-forward over that many trades");
  console.log("  cannot settle which signal is better and this report does not claim it does. What it");
  console.log("  establishes is whether the three DISAGREE today, and in which direction - which is the");
  console.log("  question worth answering before the boost grows, not after.");
  console.log("=".repeat(100));
}

if (require.main === module) main();

module.exports = { loadLiveBoostCurve, ratesFrom, walkForward, loadClosedTrades, selftest };
