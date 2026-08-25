#!/usr/bin/env node
/* ============================================================================
   sizing_walkforward.cjs — does risk-based sizing beat the fixed lot, in MONEY?
   ============================================================================

   WHY THIS EXISTS, AND WHY mtf_walkforward.cjs CANNOT ANSWER IT.

   Every other harness in this project measures in R: a win scores rr - cost, a
   loss scores -(1 + cost). That is deliberate and correct for judging an EDGE,
   and it makes those harnesses completely BLIND to position sizing, because R
   has already divided the sizing out. Run mtf_walkforward against two sizing
   regimes and it returns the identical number twice, which reads as "sizing
   does not matter" when what actually happened is "this instrument cannot see
   sizing at all".

   The R sequence here is IDENTICAL between the two regimes being compared. Same
   entries, same stops, same exits, same wins and losses, in the same order. The
   ONLY thing that differs is how much money rides on each R. That is the whole
   experiment.

   WHAT IT COMPARES

     FIXED  what the system does today: fixedLotSize lots on every trade,
            raised to the broker minimum where the minimum is larger. This is
            what mt5_bridge.py:1125 does when fixedLotSize > 0 - it discards
            the risk calculation entirely.

     RISK   what server/sizing.js:calcATRSize and mt5_bridge.py:1112 already
            implement and never get to run: lots such that the distance from
            entry to stop costs riskPercent of the CURRENT balance, floored at
            the broker minimum, quantised to the lot step, capped at maxLotSize.

   WHAT IT DOES NOT DO

   It does not touch a setting, a gate or a live position. It reads a replay and
   does arithmetic. feedsTheGate is false and there is no write path.

   THINGS THAT WOULD MAKE THE ANSWER WRONG, STATED UP FRONT

   1. NO MARGIN MODEL. At riskPercent 1 on this balance a single Gold trade can
      demand far more notional than the fixed 0.02 lot does. A real account can
      refuse that order. This harness will happily "take" it, so the RISK curve
      is an UPPER BOUND on what the account could actually have traded.
   2. SEQUENTIAL COMPOUNDING. Trades from different symbols can be open at the
      same time in reality; this walks them one after another in time order and
      compounds the balance as it goes. That overstates compounding slightly for
      both regimes, and it overstates it MORE for RISK, which is the regime that
      compounds.
   3. THE BROKER MINIMUM CAN DOMINATE. SP500's minimum is 0.1 lots. If 1% of
      balance implies less than that, RISK is forced up to the minimum and the
      two regimes converge on that symbol. Reported per symbol, not hidden.
   4. Costs are charged at the same COST_R the rest of the project uses. That is
      a fraction of R, so it scales with the position in both regimes equally.

   Usage:
     node tasks/sizing_walkforward.cjs
     node tasks/sizing_walkforward.cjs --balance 97589.26 --risk-pct 1 --fixed 0.02
     node tasks/sizing_walkforward.cjs --risk-pct 0.25        # a staged, smaller step
     node tasks/sizing_walkforward.cjs --json
   ============================================================================ */
"use strict";

const path = require("path");
const fs   = require("fs");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { cappedRr } = require(path.join(ROOT, "tasks", "_rr_cap.cjs"));

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const flag = n => process.argv.includes(n);

const BALANCE   = Number(opt("--balance", "97589.26"));
const RISK_PCT  = Number(opt("--risk-pct", "1")) / 100;
const FIXED_LOT = Number(opt("--fixed", "0.02"));
const MAX_LOT   = Number(opt("--max-lot", "10"));
const GATE      = Number(opt("--gate", "70"));
const FOLDS     = Number(opt("--folds", "5"));
const COST_R    = Number(opt("--cost", "0.05"));
const CONF_FLOOR = 40;
const AS_JSON   = flag("--json");

// Broker contract specs. Defaults are what /api/broker-specs reported on
// 2026-08-25 from the live bridge; --specs takes a JSON file to override so this
// is not quietly frozen against a broker that changed its minimums.
const DEFAULT_SPECS = {
  BTCUSD: { valuePerPoint: 0.733385159217918, minLot: 0.01, lotStep: 0.01 },
  XAUUSD: { valuePerPoint: 73.3385159217918,  minLot: 0.01, lotStep: 0.01 },
  SP500:  { valuePerPoint: 0.733385159217918, minLot: 0.1,  lotStep: 0.1  },
};
let SPECS = DEFAULT_SPECS;
const specsPath = opt("--specs", null);
if (specsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(specsPath, "utf8"));
    const src = raw.symbols || raw;
    SPECS = {};
    for (const [sym, v] of Object.entries(src)) {
      SPECS[sym] = {
        valuePerPoint: Number(v.valuePerPoint),
        minLot: Number(v.minLot),
        lotStep: Number(v.lotStep),
      };
    }
  } catch (e) {
    console.error("Could not read --specs " + specsPath + ": " + e.message);
    process.exit(1);
  }
}

const ASSETS = [["BTCUSD", "BTC-USD"], ["XAUUSD", "GC=F"], ["SP500", "^GSPC"]];

// ── replay ──────────────────────────────────────────────────────────────────
// MTF_EMIT_RISK is what makes this possible at all: without it the replay emits
// no stop distance and no entry price, and money cannot be computed from R alone.
function replay(symbol, ticker) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    {
      env: { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR), MTF_EMIT_RISK: "1" },
      maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000,
    }
  );
  return JSON.parse(stdout);
}

// ── sizing ──────────────────────────────────────────────────────────────────
function quantise(lots, step, minLot) {
  if (!(step > 0)) return Math.max(lots, minLot);
  // FLOOR, never round: rounding up asks the broker for more risk than the
  // calculation authorised, which is the wrong direction to be wrong in.
  let q = Math.floor(lots / step) * step;
  q = Number(q.toFixed(8));                 // kill float dust
  if (q < minLot) q = minLot;               // the broker's floor always wins
  return q;
}

function fixedLots(spec) {
  return quantise(Math.max(FIXED_LOT, spec.minLot), spec.lotStep, spec.minLot);
}

// Set by --sweep so ONE replay can be scored at several risk budgets. null means
// "use the CLI value", so the single-run path is completely unaffected.
let RISK_PCT_OVERRIDE = null;
const activeRiskPct = () => (RISK_PCT_OVERRIDE === null ? RISK_PCT : RISK_PCT_OVERRIDE);

function riskLots(spec, riskDistance, balance) {
  const perLot = riskDistance * spec.valuePerPoint;   // account currency risked by 1 lot
  if (!(perLot > 0)) return null;
  const want = (balance * activeRiskPct()) / perLot;
  const capped = Math.min(want, MAX_LOT);
  return quantise(capped, spec.lotStep, spec.minLot);
}

// ── run one regime over a trade sequence ────────────────────────────────────
function runRegime(trades, mode) {
  let balance = BALANCE;
  let peak = balance;
  let maxDD = 0;
  const curve = [];
  const rets = [];
  let forcedToMin = 0;
  let capHits = 0;

  for (const t of trades) {
    const spec = SPECS[t.symbol];
    if (!spec) continue;

    // R for this trade, on exactly the basis mtf_walkforward uses, so the two
    // harnesses cannot disagree about what happened - only about what it was worth.
    let r;
    if (t.outcome === "WIN")       r = cappedRr(t.rr) - COST_R;
    else if (t.outcome === "LOSS") r = -(1 + COST_R);
    else continue;                                  // EXPIRED: never resolved

    const lots = mode === "FIXED"
      ? fixedLots(spec)
      : riskLots(spec, t.risk, balance);
    if (lots === null) continue;

    if (mode === "RISK") {
      const want = (balance * activeRiskPct()) / (t.risk * spec.valuePerPoint);
      if (want < spec.minLot) forcedToMin++;         // the broker floor, not our choice
      if (want > MAX_LOT) capHits++;
    }

    const pnl = r * t.risk * spec.valuePerPoint * lots;
    const before = balance;
    balance += pnl;
    // A blown account is a terminal state, not a negative balance to keep trading.
    if (balance <= 0) { balance = 0; curve.push({ t: t.t, balance, pnl, lots, r }); break; }

    rets.push(pnl / before);
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak;
    if (dd > maxDD) maxDD = dd;
    curve.push({ t: t.t, balance, pnl, lots, r });
  }

  const n = rets.length;
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1
    ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
    : 0;

  // Annualised on the trade RATE this sequence actually produced, not on 252.
  // This book fills on the order of a hundred times a year, and pretending it is
  // daily would inflate the Sharpe by a factor of about 1.6.
  const spanMs = curve.length > 1 ? (curve[curve.length - 1].t - curve[0].t) : 0;
  const years = spanMs > 0 ? spanMs / (365.25 * 24 * 3600 * 1000) : 0;
  const perYear = years > 0 ? n / years : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(perYear) : 0;
  const cagr = (years > 0 && BALANCE > 0 && balance > 0)
    ? (Math.pow(balance / BALANCE, 1 / years) - 1) * 100
    : 0;

  return {
    mode, trades: n, terminal: balance, netPnl: balance - BALANCE,
    returnPct: ((balance - BALANCE) / BALANCE) * 100,
    maxDDPct: maxDD * 100, sharpe, cagr, years, perYear,
    forcedToMin, capHits, curve,
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const all = [];
const perAssetNote = {};
for (const [symbol, ticker] of ASSETS) {
  let trades;
  try {
    trades = replay(symbol, ticker);
  } catch (err) {
    perAssetNote[symbol] = "REPLAY FAILED: " + String(err.message || err).slice(0, 200);
    continue;
  }
  // The live gate decides the population. A sizing question asked of trades the
  // gate would never admit is a question about a different system.
  const kept = trades.filter(t => Number(t.conf) >= GATE && Number.isFinite(t.risk) && t.risk > 0);
  const noRisk = trades.filter(t => Number(t.conf) >= GATE && !(Number(t.risk) > 0)).length;
  perAssetNote[symbol] = kept.length + " trades at gate " + GATE
    + (noRisk ? " (" + noRisk + " dropped: no usable stop distance)" : "");
  // _replay_mtf.cjs emits `t` in SECONDS. Reading it as milliseconds buckets every
  // trade into January 1970, which does not change a return or a fold - those do not
  // depend on the clock - but silently destroys anything annualised: it turned this
  // book's ~100 trades/year into 48,180/year and printed a CAGR of 6.2e+30%. Range
  // -checked rather than trusted, so a future replay that switches to milliseconds
  // is caught instead of being multiplied by a thousand a second time.
  for (const t of kept) {
    const secs = Number(t.t);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    // Anything below this is not a plausible ms epoch for market data, so it is seconds.
    const ms = secs < 1e11 ? secs * 1000 : secs;
    all.push({ ...t, symbol, t: ms });
  }
}

all.sort((a, b) => a.t - b.t);

if (all.length === 0) {
  console.error("No trades at gate " + GATE + ". Nothing to measure.");
  console.error(JSON.stringify(perAssetNote, null, 2));
  process.exit(1);
}

const SPAN = new Date(all[0].t).toISOString().slice(0, 10)
         + " -> " + new Date(all[all.length - 1].t).toISOString().slice(0, 10);

// --sweep scores several risk budgets from ONE replay. The replay is the slow part
// (minutes); the arithmetic is microseconds, so re-running it per level burned almost
// all the wall clock and made the comparison expensive enough to skip.
if (process.argv.includes("--sweep")) {
  const pad = (v, n) => String(v).padEnd(n);
  console.log("");
  console.log("SIZING SWEEP - one replay, " + all.length + " trades at gate " + GATE
            + ", " + SPAN + ", balance " + BALANCE.toFixed(0));
  console.log("=".repeat(84));
  console.log("  " + pad("riskPct", 10) + pad("return", 11) + pad("CAGR", 10)
            + pad("maxDD", 10) + pad("Sharpe", 9) + pad("ret/DD", 9)
            + pad("floored", 10) + "capped");
  const show = (label, row, floored, capped) => {
    console.log("  " + pad(label, 10)
      + pad((row.returnPct >= 0 ? "+" : "") + row.returnPct.toFixed(1) + "%", 11)
      + pad((row.cagr >= 0 ? "+" : "") + row.cagr.toFixed(1) + "%", 10)
      + pad(row.maxDDPct.toFixed(1) + "%", 10)
      + pad(row.sharpe.toFixed(2), 9)
      + pad(row.maxDDPct > 0 ? (row.returnPct / row.maxDDPct).toFixed(2) : "-", 9)
      + pad(floored, 10) + capped);
  };
  show("FIXED", runRegime(all, "FIXED"), "-", "-");
  for (const lvl of [0.10, 0.25, 0.50, 0.75, 1.00, 1.50, 2.00]) {
    RISK_PCT_OVERRIDE = lvl / 100;
    const row = runRegime(all, "RISK");
    // How much of the book the broker MINIMUM sized instead of the risk budget.
    // This is the number that explains the whole table: at small budgets most trades
    // are floored up to the minimum lot, so they are not risk-sized at all and the
    // regime quietly collapses back toward FIXED.
    const floored = row.trades ? Math.round((row.forcedToMin / row.trades) * 100) + "%" : "-";
    show(lvl.toFixed(2) + "%", row, floored, String(row.capHits));
  }
  RISK_PCT_OVERRIDE = null;
  console.log("");
  console.log("  floored = share of trades the BROKER MINIMUM sized, not the risk budget.");
  console.log("            Where that is high the regime is not really risk-based at all.");
  console.log("  capped  = trades that hit maxLotSize " + MAX_LOT + ".");
  console.log("  The R sequence is identical on every row. Only the money on each R moves.");
  console.log("");
  process.exit(0);
}

const fixed = runRegime(all, "FIXED");
const risk  = runRegime(all, "RISK");

// Sequential equal-count folds, the same convention mtf_walkforward uses, so a
// fold here means the same thing as a fold there.
const foldSize = Math.floor(all.length / FOLDS);
const foldRows = [];
for (let k = 0; k < FOLDS; k++) {
  const from = k * foldSize;
  const to = (k === FOLDS - 1) ? all.length : (k + 1) * foldSize;
  const slice = all.slice(from, to);
  const f = runRegime(slice, "FIXED");
  const r = runRegime(slice, "RISK");
  foldRows.push({
    fold: k + 1, n: slice.length,
    from: new Date(slice[0].t).toISOString().slice(0, 10),
    to: new Date(slice[slice.length - 1].t).toISOString().slice(0, 10),
    fixedPct: f.returnPct, riskPct: r.returnPct,
    fixedDD: f.maxDDPct, riskDD: r.maxDDPct,
    riskWins: r.returnPct > f.returnPct,
  });
}
const foldsWon = foldRows.filter(f => f.riskWins).length;

// Risk actually taken per trade, per symbol, under each regime. This is the
// number that makes the comparison legible: the regimes differ by a multiple,
// and the multiple is not the same on every instrument.
const perSymbol = {};
for (const sym of Object.keys(SPECS)) {
  const spec = SPECS[sym];
  const rows = all.filter(t => t.symbol === sym);
  if (!rows.length) continue;
  const medRisk = rows.map(t => t.risk).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const fLots = fixedLots(spec);
  const fRisk = medRisk * spec.valuePerPoint * fLots;
  perSymbol[sym] = {
    trades: rows.length, medianStop: medRisk, fixedLots: fLots,
    fixedRiskCcy: fRisk, fixedRiskPctOfStart: (fRisk / BALANCE) * 100,
    targetRiskCcy: BALANCE * RISK_PCT,
    multiple: fRisk > 0 ? (BALANCE * RISK_PCT) / fRisk : null,
    minLotBinds: (BALANCE * RISK_PCT) / (medRisk * spec.valuePerPoint) < spec.minLot,
  };
}

const result = {
  measuredAt: new Date().toISOString(),
  inputs: { balance: BALANCE, riskPct: RISK_PCT * 100, fixedLot: FIXED_LOT,
            maxLot: MAX_LOT, gate: GATE, folds: FOLDS, costR: COST_R },
  population: perAssetNote,
  totalTrades: all.length,
  span: { from: new Date(all[0].t).toISOString().slice(0, 10),
          to: new Date(all[all.length - 1].t).toISOString().slice(0, 10),
          years: fixed.years },
  perSymbol,
  fixed: { ...fixed, curve: undefined },
  risk:  { ...risk,  curve: undefined },
  folds: foldRows,
  foldsWonByRisk: foldsWon,
  verdict: foldsWon >= 4 ? "RISK-BASED WINS" : foldsWon <= 1 ? "FIXED WINS" : "SPLIT — NOT SETTLED",
  caveats: [
    "The R sequence is IDENTICAL in both regimes. Only the money on each R differs.",
    "No margin model: the RISK curve is an UPPER BOUND on what the account could have traded.",
    "Sequential compounding across symbols overstates compounding, and more so for RISK.",
    "Where minLotBinds is true the broker floor forces the two regimes together on that symbol.",
  ],
  feedsTheGate: false,
};

if (AS_JSON) {
  const outDir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "sizing_walkforward.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(outPath);
  process.exit(0);
}

const pct = v => (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
const money = v => (v >= 0 ? "+" : "") + v.toFixed(0);

console.log("");
console.log("SIZING WALK-FORWARD — fixed lot vs risk-based, measured in MONEY");
console.log("=".repeat(78));
console.log("  balance " + BALANCE.toFixed(2) + " · riskPercent " + (RISK_PCT * 100)
          + " · fixedLotSize " + FIXED_LOT + " · gate " + GATE + " · cost " + COST_R + "R");
console.log("  " + all.length + " trades, " + result.span.from + " -> " + result.span.to
          + " (" + fixed.years.toFixed(1) + "y, " + fixed.perYear.toFixed(0) + "/yr)");
console.log("");
for (const [sym, note] of Object.entries(perAssetNote)) console.log("  " + sym.padEnd(8) + note);
console.log("");
console.log("RISK PER TRADE — what each regime actually stakes");
console.log("  " + "SYM".padEnd(8) + "med stop".padEnd(12) + "fixed lots".padEnd(12)
          + "fixed risk".padEnd(13) + "% bal".padEnd(9) + "1% target".padEnd(12) + "multiple");
for (const [sym, s] of Object.entries(perSymbol)) {
  console.log("  " + sym.padEnd(8)
    + s.medianStop.toFixed(2).padEnd(12)
    + String(s.fixedLots).padEnd(12)
    + s.fixedRiskCcy.toFixed(2).padEnd(13)
    + s.fixedRiskPctOfStart.toFixed(4).padEnd(9)
    + s.targetRiskCcy.toFixed(2).padEnd(12)
    + (s.multiple ? s.multiple.toFixed(1) + "x" : "—")
    + (s.minLotBinds ? "   [broker minimum binds]" : ""));
}
console.log("");
console.log("WHOLE PERIOD");
console.log("  " + "regime".padEnd(9) + "terminal".padEnd(13) + "return".padEnd(11)
          + "CAGR".padEnd(10) + "maxDD".padEnd(10) + "Sharpe");
for (const r of [fixed, risk]) {
  console.log("  " + r.mode.padEnd(9)
    + r.terminal.toFixed(0).padEnd(13)
    + pct(r.returnPct).padEnd(11)
    + pct(r.cagr).padEnd(10)
    + r.maxDDPct.toFixed(1).concat("%").padEnd(10)
    + r.sharpe.toFixed(2));
}
if (risk.forcedToMin) {
  console.log("  note: " + risk.forcedToMin + " RISK trade(s) were raised to the broker minimum "
            + "— on those the two regimes are the same trade.");
}
if (risk.capHits) console.log("  note: " + risk.capHits + " RISK trade(s) hit the maxLotSize cap.");
console.log("");
console.log("SEQUENTIAL OUT-OF-SAMPLE FOLDS");
console.log("  " + "fold".padEnd(6) + "n".padEnd(6) + "period".padEnd(26)
          + "FIXED".padEnd(11) + "RISK".padEnd(11) + "winner");
for (const f of foldRows) {
  console.log("  " + String(f.fold).padEnd(6) + String(f.n).padEnd(6)
    + (f.from + " -> " + f.to).padEnd(26)
    + pct(f.fixedPct).padEnd(11) + pct(f.riskPct).padEnd(11)
    + (f.riskWins ? "RISK" : "FIXED"));
}
console.log("");
console.log("  VERDICT: " + result.verdict + " — risk-based better in "
          + foldsWon + " of " + FOLDS + " folds");
console.log("");
console.log("READ THIS BEFORE ACTING ON THE NUMBERS ABOVE");
for (const c of result.caveats) console.log("  · " + c);
console.log("");
