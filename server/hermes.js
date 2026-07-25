/**
 * HERMES — forward paper-trading validation layer.
 *
 * Every signal cycle, whichever setup ("geometry") the real signal engine fires
 * gets a simulated paper position opened (if it isn't already being tracked for
 * that asset). Positions are marked to market each cycle against their real stop/
 * target. Closed trades build an out-of-sample, cost-adjusted expectancy per
 * (asset, geometry) pair — nothing here is curve-fit after the fact, since the
 * geometry's entry/stop/target were fixed by the live engine before the outcome
 * was known.
 *
 * This is a pure observation layer: it never touches riskStatus, sizing, or MT5.
 * It does not change what fires live — the 65% confidence gate and the daily-loss
 * circuit breaker are untouched.
 */
const fs   = require("fs");
const path = require("path");

const STATE_PATH       = path.join(__dirname, "hermes_state.json");
const PAPER_ENTRY_CONF = 50;   // lower than the live 65% gate — Hermes duels candidates the live gate wouldn't even show yet
const COST_R           = 0.05; // modeled spread/slippage/commission, in R, deducted from every closed trade
const MIN_SAMPLE       = 8;    // closed trades needed before a geometry's expectancy is "validated"
const MAX_HOLD_MS      = 30 * 24 * 60 * 60 * 1000; // 30 days — stale positions are marked to market and closed, not left open forever

let state = null;

function loadState() {
  if (state) return state;
  try {
    if (fs.existsSync(STATE_PATH)) {
      state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      return state;
    }
  } catch (e) { console.error("[hermes] load error:", e.message); }
  state = { inceptionAt: new Date().toISOString(), open: [], closed: [], rejections: [] };
  return state;
}

function saveState() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("[hermes] save error:", e.message); }
}

function pushRejection(asset, geometry, reason) {
  state.rejections.unshift({ asset, geometry, reason, at: new Date().toISOString() });
  if (state.rejections.length > 40) state.rejections.length = 40;
}

// Aggregate closed trades into per-(asset,geometry) stats: sample size, win rate, expectancy in R.
function computeLeaderboard() {
  loadState();
  const groups = {};
  for (const t of state.closed) {
    const k = `${t.asset}|${t.geometry}`;
    (groups[k] ??= []).push(t);
  }
  return Object.entries(groups).map(([k, trades]) => {
    const [asset, geometry] = k.split("|");
    const wins   = trades.filter(t => t.r > 0);
    const losses = trades.filter(t => t.r <= 0);
    const totalR = trades.reduce((s, t) => s + t.r, 0);
    const expectancy = totalR / trades.length;
    return {
      asset, geometry,
      trades: trades.length,
      wins: wins.length, losses: losses.length,
      winRate: Math.round((wins.length / trades.length) * 100),
      expectancy: parseFloat(expectancy.toFixed(3)),
      totalR: parseFloat(totalR.toFixed(2)),
      validated: trades.length >= MIN_SAMPLE,
    };
  }).sort((a, b) => b.expectancy - a.expectancy);
}

// Per asset: the highest-expectancy validated (enough sample, positive expectancy) geometry, if any.
function computeChampions() {
  const board = computeLeaderboard();
  const champions = {};
  for (const row of board) {
    if (!row.validated || row.expectancy <= 0) continue;
    if (!champions[row.asset] || row.expectancy > champions[row.asset].expectancy) champions[row.asset] = row;
  }
  return champions;
}

// Mark open paper positions to market against current prices — close anything that hit stop/target/max-hold.
function markToMarket(priceCache) {
  loadState();
  const stillOpen = [];
  for (const pos of state.open) {
    const price = priceCache[pos.asset];
    const age   = Date.now() - new Date(pos.openedAt).getTime();
    let outcome = null; // { r, result }

    if (price != null) {
      const hitTarget = pos.dir === "BUY" ? price >= pos.target : price <= pos.target;
      const hitStop   = pos.dir === "BUY" ? price <= pos.stop   : price >= pos.stop;
      if (hitTarget) outcome = { r: pos.rr - COST_R, result: "WIN" };
      else if (hitStop) outcome = { r: -1 - COST_R, result: "LOSS" };
    }
    if (!outcome && age > MAX_HOLD_MS) {
      // Stale — mark to market at current price as a partial result rather than hang forever.
      const partialR = price != null ? ((price - pos.entry) / Math.abs(pos.entry - pos.stop)) * (pos.dir === "BUY" ? 1 : -1) : 0;
      outcome = { r: parseFloat((partialR - COST_R).toFixed(3)), result: "STALE_CLOSE" };
    }

    if (outcome) {
      state.closed.unshift({ ...pos, closedAt: new Date().toISOString(), r: parseFloat(outcome.r.toFixed(3)), result: outcome.result });
      if (state.closed.length > 500) state.closed.length = 500;
    } else {
      stillOpen.push(pos);
    }
  }
  state.open = stillOpen;
}

// Open new paper positions for whatever the live signal engine fired this cycle, subject to the gate.
function openNewDuels(signalCache) {
  loadState();
  const board = computeLeaderboard();
  for (const asset of ["btc", "gold", "spx"]) {
    const sig = signalCache[asset];
    if (!sig || sig.signal === "WAIT" || !sig.entry || !sig.stop || !sig.target) continue;
    const geometry = sig.setup;
    if (!geometry || geometry === "BB_SQUEEZE_WATCH") continue; // watch-only state, not an entry
    if ((sig.confidence ?? 0) < PAPER_ENTRY_CONF) continue;

    const alreadyOpen = state.open.some(p => p.asset === asset && p.geometry === geometry);
    if (alreadyOpen) continue;

    const row = board.find(r => r.asset === asset && r.geometry === geometry);
    if (row && row.validated && row.expectancy < 0) {
      pushRejection(asset, geometry, `benched — negative expectancy ${row.expectancy}R over ${row.trades} trades`);
      continue;
    }

    state.open.push({
      id: `${asset}-${geometry}-${Date.now()}`,
      asset, geometry, dir: sig.signal,
      entry: sig.entry, stop: sig.stop, target: sig.target, rr: sig.rr ?? 1.5,
      confidence: sig.confidence, openedAt: new Date().toISOString(),
    });
  }
}

// Called once per signal-refresh cycle, right after signalCache is populated.
function runHermesCycle(signalCache, priceCache) {
  loadState();
  try {
    markToMarket({ btc: priceCache.btc, gold: priceCache.gold, spx: priceCache.spx });
    openNewDuels(signalCache);
    saveState();
  } catch (e) {
    console.error("[hermes] cycle error:", e.message);
  }
}

function getSnapshot(signalCache, priceCache) {
  loadState();
  const pulse = {};
  for (const asset of ["btc", "gold", "spx"]) {
    const sig = signalCache[asset];
    pulse[asset] = sig ? {
      price: priceCache[asset] ?? null,
      signal: sig.signal, confidence: sig.confidence, setup: sig.setup,
      trend: sig.trend, regime: sig.regime,
    } : null;
  }
  return {
    inceptionAt: state.inceptionAt,
    pulse,
    duel: {
      open: state.open,
      closedCount: state.closed.length,
    },
    leaderboard: computeLeaderboard(),
    champions: computeChampions(),
    rejections: state.rejections.slice(0, 15),
  };
}

module.exports = { runHermesCycle, getSnapshot, computeLeaderboard, computeChampions };
