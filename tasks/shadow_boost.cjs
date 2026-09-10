// SHADOW BOOST - what the learning boost WOULD be if it read expectancy instead of
// win rate, trained on episodes instead of on sixteen fills.
//
// READ-ONLY. IT NEVER WRITES server/learning.json, THE JOURNAL, OR ANY CALIBRATION DATA.
// It reads them, computes a second opinion, and writes its own two files. The live boost
// is untouched and keeps deciding exactly what it decides today. This is the same shape
// as `shadow` in /api/learning: it accumulates alongside and gates nothing.
//
// WHY, measured 2026-09-10 from the live /api/learning:
//   MOMENTUM  12 trades  winRate 50%  boost 0  totalPnl -250.62  avgRealizedR +0.089
//   boostBasis: { readsWinRateOnly: true, readsPnl: false, readsPerSymbol: false }
// A setup at 50% produces boost 0 whether it made +250 or lost 250. totalRealizedR and
// totalPnl are ALREADY computed and stored in the same object and the boost simply never
// consults them. Three of the four setups sit at n=1 against a floor of 5, so they cannot
// learn at all. That is why 469 sessions have produced a boost of 0 everywhere: not "no
// edge found", but the only statistic it reads being the one that cannot see an edge.
//
// THE TRAINING SET ALREADY EXISTS AND IS ~137x BIGGER THAN THE FILLS.
// tasks/rejections_scored.jsonl holds every episode the engine evaluated, already
// forward-scored in R by the existing rejection scorer. Episodes supply the PRIOR; the
// real fills update it. That is the "training" part, and it is ordinary empirical Bayes
// rather than anything clever: thin fill evidence stays near what the episodes say, and
// real fill volume pulls away from it.
//
//   node tasks/shadow_boost.cjs            compute, report, write the two output files
//   node tasks/shadow_boost.cjs --quiet    same, without the per-setup table
//
// Exit 0 always.

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LEARNING = path.join(ROOT, "server", "learning.json");
const EPISODES = path.join(ROOT, "tasks", "rejections_scored.jsonl");
const JOURNAL  = path.join(ROOT, "server", "journal.json");
const OUT_JSON = path.join(ROOT, "dashboard", "shadow-boost.json");
const OUT_TEXT = path.join(ROOT, "tasks", "analysis", "shadow-boost-latest.txt");

const QUIET = process.argv.includes("--quiet");

// THE LIVE CONSTANTS, COPIED EXACTLY FROM server/index.js:1331-1339.
// Copied rather than imported because importing index.js would boot a second server.
// If these drift, the comparison is meaningless - so the script checks them below.
const LEARNING_MIN_TRADES = 5;
const LEARNING_BOOST_CAP  = 15;
const LEARNING_BOOST_SPAN = 30;
const LEARNING_SHRINK_PSEUDO_TRADES = 10;

// R expectancy that earns the full boost. 0.5R per trade is a strong edge; mapping it to
// the same +15 the live rule gives a 100% win rate keeps the two on one scale so the
// numbers can be compared at all.
const R_FOR_FULL_BOOST = 0.5;
const R_SPAN = LEARNING_BOOST_CAP / R_FOR_FULL_BOOST;

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
}
function readJsonl(f) {
  try {
    return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
const round2 = (n) => (Number.isFinite(n) ? Number(n.toFixed(4)) : null);

// EXACT reimplementation of getLearningBoost (server/index.js:1376-1396), so that any
// difference reported below comes from the STATISTIC and not from two different formulas.
function liveBoost(wins, losses) {
  const total = wins + losses;
  if (total < LEARNING_MIN_TRADES) return 0;
  const winRate = wins / total;
  if (winRate >= 0.5) {
    return Math.max(-LEARNING_BOOST_CAP,
           Math.min(LEARNING_BOOST_CAP, Math.round((winRate - 0.5) * LEARNING_BOOST_SPAN)));
  }
  const k = LEARNING_SHRINK_PSEUDO_TRADES;
  const shrunk = (wins + k / 2) / (total + k);
  return Math.max(-LEARNING_BOOST_CAP, Math.min(0, Math.round((shrunk - 0.5) * LEARNING_BOOST_SPAN)));
}

// The shadow: same cap, same span, same asymmetry - a different input.
//
// THE ASYMMETRY IS KEPT DELIBERATELY. A negative boost is the only thing that can stop a
// setup firing, and the live rule shrinks the negative side toward a prior for exactly
// that reason. Dropping that here would produce a shadow that, if it ever graduated,
// could fire LESS often than today - which is the one thing this system must not do.
function shadowBoostFrom(shrunkR) {
  const raw = Math.round(shrunkR * R_SPAN);
  return Math.max(-LEARNING_BOOST_CAP, Math.min(LEARNING_BOOST_CAP, raw));
}

function main() {
  const learning = readJson(LEARNING, null);
  if (!learning || !learning.setupStats) {
    console.log("shadow_boost: cannot read server/learning.json - nothing computed, nothing written");
    return 0;
  }

  // GUARD: if the live constants have moved, every comparison below is misleading.
  // Read them out of the source rather than trusting this file's copy.
  let drift = null;
  try {
    const src = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
    const grab = (name) => {
      const m = new RegExp("const\\s+" + name + "\\s*=\\s*(-?\\d+)").exec(src);
      return m ? Number(m[1]) : null;
    };
    const live = {
      LEARNING_MIN_TRADES: grab("LEARNING_MIN_TRADES"),
      LEARNING_BOOST_CAP:  grab("LEARNING_BOOST_CAP"),
      LEARNING_BOOST_SPAN: grab("LEARNING_BOOST_SPAN"),
      LEARNING_SHRINK_PSEUDO_TRADES: grab("LEARNING_SHRINK_PSEUDO_TRADES"),
    };
    const mine = { LEARNING_MIN_TRADES, LEARNING_BOOST_CAP, LEARNING_BOOST_SPAN, LEARNING_SHRINK_PSEUDO_TRADES };
    const bad = Object.keys(mine).filter((k) => live[k] !== null && live[k] !== mine[k]);
    if (bad.length) drift = bad.map((k) => k + ": source " + live[k] + " vs this file " + mine[k]);
  } catch { /* source unreadable - reported as unknown below */ }

  //--- episodes, the prior ----------------------------------------
  const episodes = readJsonl(EPISODES).filter((e) => e.setup && Number.isFinite(Number(e.r)));
  const byEpisodeSetup = new Map();
  for (const e of episodes) {
    if (!byEpisodeSetup.has(e.setup)) byEpisodeSetup.set(e.setup, []);
    byEpisodeSetup.get(e.setup).push(e);
  }

  //--- fills, per setup AND per symbol -----------------------------
  const journal = readJson(JOURNAL, []);
  const fills = (Array.isArray(journal) ? journal : (journal.trades || []))
    .filter((t) => t && t.status === "CLOSED" && t.setup);

  const rows = [];
  for (const [setup, s] of Object.entries(learning.setupStats)) {
    const wins = Number(s.wins) || 0, losses = Number(s.losses) || 0;
    const n = wins + losses;
    const fillAvgR = Number.isFinite(Number(s.avgRealizedR)) ? Number(s.avgRealizedR) : null;

    const eps = byEpisodeSetup.get(setup) || [];
    const epN = eps.length;
    const epAvgR = epN ? eps.reduce((a, e) => a + Number(e.r), 0) / epN : null;

    // Empirical-Bayes shrinkage toward the episode expectancy. With no episodes the prior
    // is 0 (break-even), which is the same neutral assumption the live rule makes.
    const priorR = epAvgR === null ? 0 : epAvgR;
    const k = LEARNING_SHRINK_PSEUDO_TRADES;
    const shrunkR = (fillAvgR === null || n === 0)
      ? priorR
      : ((fillAvgR * n) + (priorR * k)) / (n + k);

    const live = liveBoost(wins, losses);
    const shadow = shadowBoostFrom(shrunkR);

    // PER SYMBOL, which the live rule explicitly does not do. Gold moves 74 GBP a point
    // and SP500 moves 0.74 - pooling them averages two different games.
    const mine = fills.filter((t) => t.setup === setup);
    const perSymbol = {};
    for (const t of mine) {
      const sym = t.symbol || "?";
      if (!perSymbol[sym]) perSymbol[sym] = { n: 0, pnl: 0, r: 0, rN: 0 };
      perSymbol[sym].n++;
      perSymbol[sym].pnl += Number(t.pnl) || 0;
      if (Number.isFinite(Number(t.rr))) { /* planned rr, not realised - not summed */ }
    }
    const totalPnl = Number(s.totalPnl) || 0;

    // THE INCOMMENSURABILITY DETECTOR. A setup that is R-positive and money-negative is
    // the exact condition the analyst measured across the whole book (+0.56R, -670.17).
    const signDisagrees = fillAvgR !== null && n > 0 &&
      ((fillAvgR > 0 && totalPnl < 0) || (fillAvgR < 0 && totalPnl > 0));

    rows.push({
      setup, n, wins, losses,
      winRate: n ? round2((wins / n) * 100) : null,
      totalPnl: round2(totalPnl),
      fillAvgR: round2(fillAvgR),
      episodeN: epN, episodeAvgR: round2(epAvgR),
      shrunkR: round2(shrunkR),
      liveBoost: live, shadowBoost: shadow,
      delta: shadow - live,
      shadowWouldFireLess: shadow < live,
      belowLiveFloor: n < LEARNING_MIN_TRADES,
      signDisagrees,
      perSymbol,
    });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const disagree = rows.filter((r) => r.delta !== 0);
  const fireLess = rows.filter((r) => r.shadowWouldFireLess);

  const out = {
    source: "shadow_boost.cjs",
    generatedAt: new Date().toISOString(),
    feedsTheGate: false,
    readOnly: true,
    note: "Second opinion on the learning boost. Reads server/learning.json, the journal and " +
          "tasks/rejections_scored.jsonl; WRITES NEITHER - only its own two output files. The live " +
          "boost is unchanged and still decides everything. Nothing here may graduate without a " +
          "walk-forward that clears it.",
    constants: { LEARNING_MIN_TRADES, LEARNING_BOOST_CAP, LEARNING_BOOST_SPAN,
                 LEARNING_SHRINK_PSEUDO_TRADES, R_FOR_FULL_BOOST },
    constantDrift: drift,
    liveBasis: "win rate only (readsPnl:false, readsPerSymbol:false)",
    shadowBasis: "realised R per fill, shrunk toward the episode expectancy as prior",
    fillsUsed: fills.length,
    episodesUsed: episodes.length,
    setups: rows.length,
    disagreeing: disagree.length,
    shadowWouldFireLessCount: fireLess.length,
    rows,
  };

  fs.mkdirSync(path.dirname(OUT_TEXT), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), "utf8");

  const L = [];
  L.push("SHADOW BOOST - " + out.generatedAt);
  L.push("READ-ONLY. learning.json, the journal and the calibration data were NOT written.");
  if (drift) { L.push("!! CONSTANT DRIFT - the comparison is unsafe until this is fixed:"); for (const d of drift) L.push("   " + d); }
  L.push("live basis  : " + out.liveBasis);
  L.push("shadow basis: " + out.shadowBasis);
  L.push("fills " + fills.length + ", scored episodes " + episodes.length +
         "  (" + (fills.length ? Math.round(episodes.length / fills.length) : "-") + "x the sample)");
  L.push("");
  L.push("setup".padEnd(20) + "n".padStart(4) + "win%".padStart(7) + "pnl".padStart(10) +
         "fillR".padStart(8) + "epN".padStart(6) + "epR".padStart(8) + "shrunkR".padStart(9) +
         "live".padStart(6) + "shadow".padStart(8) + "delta".padStart(7));
  for (const r of rows) {
    L.push(r.setup.padEnd(20) + String(r.n).padStart(4) + String(r.winRate ?? "-").padStart(7) +
           String(r.totalPnl ?? "-").padStart(10) + String(r.fillAvgR ?? "-").padStart(8) +
           String(r.episodeN).padStart(6) + String(r.episodeAvgR ?? "-").padStart(8) +
           String(r.shrunkR ?? "-").padStart(9) + String(r.liveBoost).padStart(6) +
           String(r.shadowBoost).padStart(8) + String(r.delta > 0 ? "+" + r.delta : r.delta).padStart(7) +
           (r.belowLiveFloor ? "   below live n=5 floor" : "") +
           (r.signDisagrees ? "   R and MONEY DISAGREE" : ""));
  }
  L.push("");
  L.push("setups where the two disagree: " + disagree.length + " of " + rows.length);
  L.push("setups where the shadow would fire LESS than today: " + fireLess.length +
         (fireLess.length ? "  -> " + fireLess.map((r) => r.setup).join(", ") : ""));
  L.push("");
  L.push("NOT WIRED IN. The live boost decides everything exactly as before.");
  fs.writeFileSync(OUT_TEXT, L.join("\n") + "\n", "utf8");

  if (!QUIET) console.log(L.join("\n"));
  console.log("");
  console.log("  wrote dashboard/shadow-boost.json and tasks/analysis/shadow-boost-latest.txt");
  console.log("  learning.json NOT touched (mtime unchanged): " +
              new Date(fs.statSync(LEARNING).mtime).toISOString());
  return 0;
}

process.exit(main());
