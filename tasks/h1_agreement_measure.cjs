// Does it cost anything to enter against the 1-hour chart?
//
// WHY THIS EXISTS. CLAUDE.md claimed for weeks that a signal "fires only at or above
// the live confidenceThreshold across Daily + 4H + 1H". That is false and was corrected
// 2026-08-31: `h1` appears exactly twice in server/index.js -- a BONUS branch at :2909
// that raises confidence when all three agree, and a payload copy at :3221 that the
// dashboard renders. No branch anywhere lets H1 reduce confidence or block a setup, and
// the bridge never reads h1 or m15 to refuse a trade. So the honest answer to "why does
// it buy when the hourly is bearish" was: because nothing has ever stopped it, and
// nobody has ever measured whether stopping it would help.
//
// This measures that. It changes NOTHING -- no gate, no threshold, no config, no setting.
// It is a read-only replay that prints a table.
//
// READ THE RESULT THE RIGHT WAY. A negative DISAGREE bucket is NOT a licence to add an
// H1 veto. Standing rule 3: a change whose mechanism is subtraction is presumed wrong
// here, because sample size is the binding constraint and every filter spends it. The
// only thing a negative bucket licenses is a WEIGHTING proposal -- and only if it holds
// across folds, because a single cut is not evidence (see the trailing-ladder reversal
// of 2026-08-07, where a 5/5 result died the same day it was re-cut).
//
//   node tasks/h1_agreement_measure.cjs [--threshold 70] [--folds 5] [--quiet]
//
// Appends to tasks/logs/h1_agreement.txt.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LOG  = path.join(ROOT, "tasks", "logs", "h1_agreement.txt");

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf("--" + name);
  return i === -1 ? def : argv[i + 1];
}
const THRESHOLD = Number(flag("threshold", 70));
const FOLDS     = Number(flag("folds", 5));
const QUIET     = argv.includes("--quiet");

if (!Number.isFinite(THRESHOLD) || THRESHOLD < 1 || THRESHOLD > 100) {
  console.error("--threshold must be 1..100");
  process.exit(1);
}
if (!Number.isFinite(FOLDS) || FOLDS < 2) {
  console.error("--folds must be >= 2");
  process.exit(1);
}

// The three the engine actually trades. NAS100/BAC exist in tasks/history from the
// instrument scan but are not live symbols, so including them would answer a different
// question than the one asked.
const SYMBOLS = [
  { symbol: "XAUUSD", ticker: "GC=F"  },
  { symbol: "BTCUSD", ticker: "BTC-USD" },
  { symbol: "SP500",  ticker: "^GSPC" },
];

// ── run one replay ───────────────────────────────────────────────────────────
function replay(symbol, ticker) {
  let raw;
  try {
    raw = execFileSync(process.execPath,
      [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(THRESHOLD)],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        // MTF_EMIT_R is the replay's OWN opt-in for realisedR (_replay_mtf.cjs:479). It is
        // gated by default because the bare output hash is what the two-box parity check
        // compares, so adding the field unconditionally would break that check. Setting it
        // here, per-run, in this child process only, leaves the default output untouched.
        // Do NOT set MTF_TRAIL_LADDER: the ladder is measured OFF (2026-08-07, the only
        // give-back never negative across 4/5/7 folds), and arming it here would price a
        // configuration the live bridge does not run.
        env: { ...process.env, MTF_EMIT_R: "1" } });
  } catch (e) {
    // A symbol that cannot be replayed must not take the whole run down with it, and it
    // must not be silently counted as zero trades either -- that would read as "no cost"
    // when the truth is "no measurement". Named and skipped.
    return { error: (e && e.message ? e.message.split("\n")[0] : String(e)) };
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("MTF_CENSUS")) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const rows = Array.isArray(parsed) ? parsed : parsed.trades;
    if (Array.isArray(rows)) return { rows };
  }
  return { error: "replay produced no trade array" };
}

// ── bucketing ────────────────────────────────────────────────────────────────
// Two different questions, deliberately kept apart:
//   bySignal — did the H1 SETUP point the same way? Mostly WAIT, because a setup is rare.
//   byTrend  — did the H1 TREND point the same way? This is the one a human means by
//              "the 1h is bearish", and it is populated on almost every bar.
const BULL = new Set(["UPTREND", "STRONG UPTREND"]);
const BEAR = new Set(["DOWNTREND", "STRONG DOWNTREND"]);

function signalBucket(t) {
  if (t.h1dir == null) return "UNKNOWN";
  if (t.h1dir === "WAIT") return "NEUTRAL";
  return t.h1dir === t.dir ? "AGREE" : "DISAGREE";
}

function trendBucket(t) {
  if (t.h1trend == null) return "UNKNOWN";
  const bull = BULL.has(t.h1trend), bear = BEAR.has(t.h1trend);
  if (!bull && !bear) return "NEUTRAL";           // MIXED
  const withTrend = (t.dir === "BUY" && bull) || (t.dir === "SELL" && bear);
  return withTrend ? "AGREE" : "DISAGREE";
}

// EXPIRED trades carry realisedR too (the replay marks them and still prices the exit),
// but a null must never be silently read as 0R -- that would drag every mean toward zero
// and make a real effect look like noise. Counted separately and excluded from the mean.
function summarise(rows) {
  const scored = rows.filter(r => Number.isFinite(r.realisedR));
  const unscored = rows.length - scored.length;
  if (!scored.length) return { n: rows.length, scored: 0, unscored, wins: 0, winPct: null, meanR: null, totalR: null };
  const wins = scored.filter(r => r.realisedR > 0).length;
  const totalR = scored.reduce((s, r) => s + r.realisedR, 0);
  return {
    n: rows.length, scored: scored.length, unscored, wins,
    winPct: +(wins / scored.length * 100).toFixed(1),
    meanR:  +(totalR / scored.length).toFixed(3),
    totalR: +totalR.toFixed(2),
  };
}

// Fold stability. One cut is not evidence; this reports how many folds keep the sign.
function foldSigns(rows, k) {
  const scored = rows.filter(r => Number.isFinite(r.realisedR)).sort((a, b) => a.t - b.t);
  if (scored.length < k * 4) return null;          // too thin to cut meaningfully
  const size = Math.floor(scored.length / k);
  const means = [];
  for (let i = 0; i < k; i++) {
    const slice = scored.slice(i * size, i === k - 1 ? scored.length : (i + 1) * size);
    if (!slice.length) continue;
    means.push(+(slice.reduce((s, r) => s + r.realisedR, 0) / slice.length).toFixed(3));
  }
  return { means, positive: means.filter(m => m > 0).length, of: means.length,
           worst: Math.min(...means) };
}

function pad(s, n) { return String(s).padEnd(n); }
function num(v, n) { return (v === null || v === undefined ? "n/a" : String(v)).padStart(n); }

const out = [];
function say(line) { out.push(line); if (!QUIET) console.log(line); }

say("=".repeat(92));
say(`  DOES ENTERING AGAINST THE 1-HOUR COST ANYTHING?  ${new Date().toISOString()}`);
say(`  threshold ${THRESHOLD}, ${FOLDS} folds. Read-only: this changes no gate, no setting, nothing.`);
say("=".repeat(92));

const all = [];
for (const { symbol, ticker } of SYMBOLS) {
  const res = replay(symbol, ticker);
  if (res.error) { say(`\n  ${symbol}: SKIPPED — ${res.error}`); continue; }
  const rows = res.rows;
  all.push(...rows);
  say(`\n  ${symbol} — ${rows.length} replayed entries`);
  for (const [label, fn] of [["H1 TREND vs trade direction", trendBucket],
                             ["H1 SETUP vs trade direction", signalBucket]]) {
    say(`    ${label}`);
    say(`      ${pad("bucket", 10)}${num("n", 6)}${num("scored", 8)}${num("win%", 8)}${num("meanR", 9)}${num("totalR", 9)}   folds`);
    for (const b of ["AGREE", "NEUTRAL", "DISAGREE", "UNKNOWN"]) {
      const sub = rows.filter(r => fn(r) === b);
      if (!sub.length) continue;
      const s = summarise(sub);
      const f = foldSigns(sub, FOLDS);
      const foldTxt = f ? `${f.positive}/${f.of} positive, worst ${f.worst}` : "too thin to cut";
      say(`      ${pad(b, 10)}${num(s.n, 6)}${num(s.scored, 8)}${num(s.winPct, 8)}${num(s.meanR, 9)}${num(s.totalR, 9)}   ${foldTxt}`);
    }
  }
}

if (all.length) {
  say("\n" + "-".repeat(92));
  say(`  POOLED across all symbols — ${all.length} entries`);
  say("  Pooling three instruments with different contract sizes is fine here ONLY because");
  say("  every figure is in R, not currency. Never repeat this table in dollars.");
  for (const [label, fn] of [["H1 TREND vs trade direction", trendBucket],
                             ["H1 SETUP vs trade direction", signalBucket]]) {
    say(`    ${label}`);
    say(`      ${pad("bucket", 10)}${num("n", 6)}${num("scored", 8)}${num("win%", 8)}${num("meanR", 9)}${num("totalR", 9)}   folds`);
    for (const b of ["AGREE", "NEUTRAL", "DISAGREE", "UNKNOWN"]) {
      const sub = all.filter(r => fn(r) === b);
      if (!sub.length) continue;
      const s = summarise(sub);
      const f = foldSigns(sub, FOLDS);
      const foldTxt = f ? `${f.positive}/${f.of} positive, worst ${f.worst}` : "too thin to cut";
      say(`      ${pad(b, 10)}${num(s.n, 6)}${num(s.scored, 8)}${num(s.winPct, 8)}${num(s.meanR, 9)}${num(s.totalR, 9)}   ${foldTxt}`);
    }
  }

  const dis = all.filter(r => trendBucket(r) === "DISAGREE");
  const agr = all.filter(r => trendBucket(r) === "AGREE");
  const ds = summarise(dis), as = summarise(agr);
  say("\n" + "-".repeat(92));
  say("  WHAT THIS DOES AND DOES NOT LICENSE");
  if (ds.meanR !== null && as.meanR !== null) {
    const gap = +(as.meanR - ds.meanR).toFixed(3);
    say(`  Against-H1-trend entries mean ${ds.meanR}R over ${ds.scored}; with-trend mean ${as.meanR}R over ${as.scored}.`);
    say(`  Gap ${gap}R per trade.`);
    const f = foldSigns(dis, FOLDS);
    // A NEGATIVE bucket holds its sign by being NEGATIVE in a fold. `positive` counts
    // folds above zero, so the stability of a negative finding is `of - positive`.
    // Reading `positive` directly here called a 4-of-5-negative result "does not survive
    // re-cutting" and would have buried the finding. Sign first, then stability.
    const negFolds = f ? f.of - f.positive : null;
    if (ds.meanR >= 0) {
      say("  DISAGREE is NOT negative. There is no case here for treating the 1-hour as a filter.");
    } else if (f && negFolds === f.of) {
      say(`  DISAGREE is negative in ALL ${f.of} folds (worst ${f.worst}).`);
    } else if (f && negFolds >= Math.ceil(f.of * 0.8)) {
      say(`  DISAGREE is negative in ${negFolds} of ${f.of} folds (worst ${f.worst}) — the sign holds.`);
    } else {
      say(`  DISAGREE is negative on the mean but only ${negFolds}/${f ? f.of : "?"} folds keep the sign.`);
      say("  A mean that does not survive re-cutting is the trailing-ladder trap of 2026-08-07.");
    }
  }

  // ── THE DISAMBIGUATION THAT DECIDES WHAT THIS FINDING IS ABOUT ─────────────
  // A DISAGREE bucket is, by construction, entries taken AGAINST the hourly trend —
  // which is the literal definition of a mean-reversion setup. So a negative DISAGREE
  // bucket has two completely different readings:
  //   (a) the 1-hour carries information the engine ignores, or
  //   (b) the mean-reversion SETUPS are bad, and "against H1" is just their fingerprint.
  // These call for opposite work, and (b) is far more likely on an engine measured
  // ~92% long. If one or two setups dominate the bucket, this is a SETUP finding wearing
  // a timeframe costume — the same shape as the RANGE_TRADE_SHORT trap of 2026-08-27.
  say("");
  say("  IS THIS ABOUT H1, OR ABOUT WHICH SETUPS LIVE IN THAT BUCKET?");
  const bySetup = new Map();
  for (const r of dis) {
    const k = r.setup || "(none)";
    if (!bySetup.has(k)) bySetup.set(k, []);
    bySetup.get(k).push(r);
  }
  const ranked = [...bySetup.entries()].sort((a, b) => b[1].length - a[1].length);
  say(`      ${pad("setup", 22)}${num("n", 5)}${num("win%", 8)}${num("meanR", 9)}   share of DISAGREE`);
  for (const [setup, rows] of ranked) {
    const s = summarise(rows);
    const share = (rows.length / dis.length * 100).toFixed(0) + "%";
    say(`      ${pad(setup, 22)}${num(s.n, 5)}${num(s.winPct, 8)}${num(s.meanR, 9)}   ${share}`);
  }
  // The counter-test: do those same setups also lose when H1 AGREES? If they do, the
  // setup is the problem and H1 is incidental. If they only lose against H1, the
  // timeframe is carrying real information.
  say("");
  say("  COUNTER-TEST — the same setups, but taken WITH the H1 trend:");
  say(`      ${pad("setup", 22)}${num("n", 5)}${num("win%", 8)}${num("meanR", 9)}   verdict`);
  for (const [setup] of ranked) {
    const withTrend = agr.filter(r => (r.setup || "(none)") === setup);
    if (!withTrend.length) { say(`      ${pad(setup, 22)}${num(0, 5)}${num(null, 8)}${num(null, 9)}   never taken with the trend`); continue; }
    const s = summarise(withTrend);
    const againstMean = summarise(bySetup.get(setup)).meanR;
    let verdict;
    if (s.meanR === null || againstMean === null) verdict = "unscorable";
    else if (s.meanR > 0 && againstMean < 0) verdict = "H1 SEPARATES IT — same setup, opposite sign";
    else if (s.meanR < 0 && againstMean < 0) verdict = "loses BOTH ways — a SETUP problem, not H1";
    else verdict = "no separation";
    say(`      ${pad(setup, 22)}${num(s.n, 5)}${num(s.winPct, 8)}${num(s.meanR, 9)}   ${verdict}`);
  }

  // Fold stability for the separating setups ONLY. A mean that flips when the boundaries
  // move is the trailing-ladder trap of 2026-08-07, where a 5/5 result died the same day
  // it was re-cut at different fold counts. Any proposal built on this table rests on
  // THIS block, not on the means above.
  say("");
  say("  FOLD STABILITY of the separating setups (the number a proposal must rest on):");
  for (const [setup, rows] of ranked) {
    const withTrend = agr.filter(r => (r.setup || "(none)") === setup);
    const againstMean = summarise(rows).meanR;
    const withMean = withTrend.length ? summarise(withTrend).meanR : null;
    if (againstMean === null || withMean === null || !(withMean > 0 && againstMean < 0)) continue;
    const fa = foldSigns(rows, FOLDS), fw = foldSigns(withTrend, FOLDS);
    const aTxt = fa ? `${fa.of - fa.positive}/${fa.of} folds NEGATIVE, worst ${fa.worst}` : `n=${rows.length}, TOO THIN TO CUT`;
    const wTxt = fw ? `${fw.positive}/${fw.of} folds positive, worst ${fw.worst}` : `n=${withTrend.length}, too thin to cut`;
    say(`      ${setup}`);
    say(`        against H1: ${aTxt}`);
    say(`        with    H1: ${wTxt}`);
    if (!fa) say("        NOT ACTIONABLE — the against-H1 leg cannot be cut into folds at this sample.");
  }
  say("  Nothing in this file feeds the gate. feedsTheGate: false.");
}
say("=".repeat(92));

try {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, out.join("\n") + "\n\n", "utf8");
  if (!QUIET) console.log(`\nAppended to ${path.relative(ROOT, LOG)}`);
} catch (e) {
  // Never swallow it: a measurement nobody can re-read tomorrow is a measurement lost.
  console.error(`[h1_agreement] could not append to the log: ${e.message}`);
  console.error("The table above is still correct; only the durable copy failed.");
  process.exitCode = 1;
}
