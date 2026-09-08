// REBUILD server/learning.json FROM THIS BOX'S OWN JOURNAL.
//
// WHY. server/learning.json was git-TRACKED while server/journal.json was not, so every
// pull overwrote a machine's learning record with the other machine's. Measured on the VPS
// 2026-09-08: three of its four setups carried P&L byte-identical to the laptop's, and its
// BB_SQUEEZE_WATCH read -449.72 against -6.80 in its own journal. The file is untracked as
// of 95aad51, so a rebuild will now stay rebuilt.
//
// The journal is the source of truth: it is the record of real fills on THIS box and it is
// not shared. Everything here is derived from it and nothing is invented.
//
// SAFE BY CONSTRUCTION:
//   - DRY RUN unless --apply, the same contract refresh_bars.cjs uses.
//   - Backs up first and VERIFIES the backup before a byte changes.
//   - Preserves every top-level key it does not own (sessionCount and anything added later).
//   - Writes to .tmp, re-parses it, and only then renames over the original.
//   - Prints BEFORE and AFTER boost for every setup and REFUSES if any boost would go
//     DOWN, so a rebuild can never cost a signal. Run it after the negative-boost floor is
//     live and that refusal cannot trigger.
//
//   node tasks/rebuild_learning_from_journal.cjs            dry run
//   node tasks/rebuild_learning_from_journal.cjs --apply    back up, write, verify

const fs = require("fs");
const path = require("path");

const ROOT     = path.join(__dirname, "..");
const LEARNING = path.join(ROOT, "server", "learning.json");
const JOURNAL  = path.join(ROOT, "server", "journal.json");
const APPLY    = process.argv.includes("--apply");

const NON_SETUP_NAMES = new Set(["WAIT", "NONE", "UNKNOWN"]);
const UNATTRIBUTED_SETUP = "UNATTRIBUTED";
const LEARNING_MIN_TRADES = 5;
const LEARNING_BOOST_CAP  = 15;
const LEARNING_BOOST_SPAN = 30;
const LEARNING_SHRINK_PSEUDO_TRADES = 10;

// Copied deliberately rather than imported: server/index.js is an express app and requiring
// it would start a second server. Kept identical to getLearningBoost in index.js - if that
// changes, change this, or the preview below stops predicting what the engine will do.
function boostOf(wins, losses) {
  const total = wins + losses;
  if (total < LEARNING_MIN_TRADES) return 0;
  const winRate = wins / total;
  if (winRate >= 0.5) {
    return Math.max(-LEARNING_BOOST_CAP, Math.min(LEARNING_BOOST_CAP,
           Math.round((winRate - 0.5) * LEARNING_BOOST_SPAN)));
  }
  const k = LEARNING_SHRINK_PSEUDO_TRADES;
  const shrunk = (wins + k / 2) / (total + k);
  return Math.max(-LEARNING_BOOST_CAP, Math.min(0, Math.round((shrunk - 0.5) * LEARNING_BOOST_SPAN)));
}

function realizedRFromPrices(direction, entryPrice, stopPrice, closePrice) {
  const prices = [entryPrice, stopPrice, closePrice];
  if (!prices.every(p => typeof p === "number" && Number.isFinite(p))) return null;
  const risk = Math.abs(entryPrice - stopPrice);
  if (risk === 0) return null;
  const isShort = String(direction || "").toUpperCase().startsWith("S");
  return (isShort ? entryPrice - closePrice : closePrice - entryPrice) / risk;
}

function log(m) { console.log("  " + m); }
const r2 = n => parseFloat(n.toFixed(2));

const existing = JSON.parse(fs.readFileSync(LEARNING, "utf8"));
const journal  = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
const closed   = journal.filter(t => t && t.status === "CLOSED" && t.pnl !== null && t.pnl !== undefined);

console.log("");
console.log("=== REBUILD learning.json FROM THIS BOX'S JOURNAL " + (APPLY ? "[APPLY]" : "[DRY RUN]") + " ===");
log("closed fills in journal: " + closed.length);

const setupStats = {};
const bySymbol   = {};
for (const t of closed) {
  const raw = t.setup;
  const isNonSetup = !raw || NON_SETUP_NAMES.has(String(raw).trim().toUpperCase());
  const win = t.pnl > 0;
  const r = realizedRFromPrices(t.direction, t.entry, t.sl, t.closePrice);

  // The asset table does NOT inherit the setup table's exclusion - index.js says why:
  // XAUUSD is XAUUSD whether or not the label survived, and dropping the row hid a winner.
  const assetKey = isNonSetup ? UNATTRIBUTED_SETUP : raw;
  if (t.symbol) {
    bySymbol[t.symbol] = bySymbol[t.symbol] || {};
    const b = bySymbol[t.symbol][assetKey] = bySymbol[t.symbol][assetKey] || { wins: 0, losses: 0, totalPnl: 0 };
    if (win) b.wins++; else b.losses++;
    b.totalPnl = r2(b.totalPnl + t.pnl);
  }
  if (isNonSetup) continue;

  const s = setupStats[raw] = setupStats[raw] || { wins: 0, losses: 0, totalPnl: 0 };
  if (win) s.wins++; else s.losses++;
  s.totalPnl = r2(s.totalPnl + t.pnl);
  if (Number.isFinite(r)) {
    s.totalRealizedR = parseFloat(((s.totalRealizedR ?? 0) + r).toFixed(4));
    s.rTrades = (s.rTrades ?? 0) + 1;
  }
}

console.log("");
log("setup                BEFORE                          AFTER");
const names = new Set([...Object.keys(existing.setupStats || {}), ...Object.keys(setupStats)]);
const wouldDrop = [];
for (const n of [...names].sort()) {
  const b = (existing.setupStats || {})[n];
  const a = setupStats[n];
  const bB = b ? boostOf(b.wins, b.losses) : 0;
  const aB = a ? boostOf(a.wins, a.losses) : 0;
  // COMPARE WHAT ACTUALLY REACHES CONFIDENCE, not the raw score. index.js applies
  // Math.max(0, learnBoost), so a move from -1 to -3 changes nothing a signal can feel -
  // both apply as 0. Comparing the raw values made this refuse on a rebuild that costs
  // nothing, which is a guard blocking the very thing it was written to make safe.
  if (Math.max(0, aB) < Math.max(0, bB)) {
    wouldDrop.push(n + ": APPLIED boost " + Math.max(0, bB) + " -> " + Math.max(0, aB));
  }
  const bs = b ? (b.wins + "W/" + b.losses + "L " + String(b.totalPnl).padStart(9) + " boost " + String(bB).padStart(3) + "->" + Math.max(0, bB)) : "(absent)";
  const as = a ? (a.wins + "W/" + a.losses + "L " + String(a.totalPnl).padStart(9) + " boost " + String(aB).padStart(3) + "->" + Math.max(0, aB)
                  + " avgR " + (a.rTrades ? (a.totalRealizedR / a.rTrades).toFixed(3) : "n/a")) : "(absent)";
  log(n.padEnd(20) + " " + bs.padEnd(31) + " " + as);
}

if (wouldDrop.length) {
  console.log("");
  log("REFUSING: this rebuild would LOWER a boost, which costs signals:");
  for (const w of wouldDrop) log("    " + w);
  log("Land the negative-boost floor first (index.js applies Math.max(0, learnBoost)),");
  log("then a truthful record cannot subtract from confidence and this refusal clears.");
  process.exit(4);
}

if (!APPLY) {
  console.log("");
  log("DRY RUN. Nothing written. Re-run with --apply to back up and write.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
const bak = LEARNING + ".bak-rebuild-" + stamp;
fs.copyFileSync(LEARNING, bak);
if (!fs.existsSync(bak) || fs.statSync(bak).size !== fs.statSync(LEARNING).size) {
  log("REFUSING: backup did not verify. Nothing written.");
  process.exit(1);
}
log("backed up -> " + path.basename(bak) + " (" + fs.statSync(bak).size + " bytes, size matches)");

// Every top-level key this script does not own is carried through untouched.
const out = Object.assign({}, existing, {
  setupStats: setupStats,
  bySymbol: bySymbol,
  rebuiltFromJournalAt: new Date().toISOString(),
  rebuiltFromClosedFills: closed.length,
});
const tmp = LEARNING + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
JSON.parse(fs.readFileSync(tmp, "utf8"));
fs.renameSync(tmp, LEARNING);

const after = JSON.parse(fs.readFileSync(LEARNING, "utf8"));
const fills = Object.values(after.setupStats).reduce((n, s) => n + s.wins + s.losses, 0);
const nonSetup = closed.filter(t => !t.setup || NON_SETUP_NAMES.has(String(t.setup).trim().toUpperCase())).length;
const ok = (fills + nonSetup === closed.length) && (after.sessionCount === existing.sessionCount);
console.log("");
log("reconciles: " + fills + " attributed + " + nonSetup + " non-setup = " + (fills + nonSetup) + " of " + closed.length + " closed fills");
log("sessionCount preserved: " + (after.sessionCount === existing.sessionCount));
log(ok ? "VERIFIED." : "*** VERIFY FAILED - restore from " + path.basename(bak));
log("RESTART THE SERVER so it loads this instead of its in-memory copy.");
process.exit(ok ? 0 : 1);
