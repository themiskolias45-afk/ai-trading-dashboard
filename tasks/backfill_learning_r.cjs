// BACKFILL realizedR INTO server/learning.json FROM THE CLOSED JOURNAL.
//
// WHY THIS EXISTS. updateLearning gained a realizedR argument on 2026-09-08, so R is
// recorded from that moment forward and the fills that closed BEFORE it carry none. The
// engine would have started its R record from zero while eleven closed trades sat in the
// journal with everything needed to compute it. This replays them once.
//
// WHAT IT WILL NOT DO:
//   - It never touches wins, losses or totalPnl. Those are the numbers weeks of real
//     trades produced and nothing here has any business rewriting them. It ADDS
//     totalRealizedR and rTrades beside them and nothing else.
//   - It refuses to run twice. updateLearning INCREMENTS, so a second application would
//     double-count every R silently. A top-level rBackfilledAt marker makes that
//     impossible to do by accident.
//   - It is DRY RUN unless --apply is passed, like tasks/refresh_bars.cjs.
//
// It uses the same formula and the same exclusions as updateLearning: NON_SETUP_NAMES are
// refused because "WAIT" is the absence of a setup, and a null R (unusable stop distance)
// is skipped on the R side while the fill still counts as a win or a loss. rTrades is
// therefore its own counter and may be lower than wins+losses.
//
//   node tasks/backfill_learning_r.cjs            dry run, shows what it would write
//   node tasks/backfill_learning_r.cjs --apply    backs up, writes, verifies

const fs = require("fs");
const path = require("path");

const ROOT     = path.join(__dirname, "..");
const LEARNING = path.join(ROOT, "server", "learning.json");
const JOURNAL  = path.join(ROOT, "server", "journal.json");
const APPLY    = process.argv.includes("--apply");
const NON_SETUP_NAMES = new Set(["WAIT", "NONE", "UNKNOWN"]);

function realizedRFromPrices(direction, entryPrice, stopPrice, closePrice) {
  const prices = [entryPrice, stopPrice, closePrice];
  if (!prices.every(p => typeof p === "number" && Number.isFinite(p))) return null;
  const riskDistance = Math.abs(entryPrice - stopPrice);
  if (riskDistance === 0) return null;
  const isShort  = String(direction || "").toUpperCase().startsWith("S");
  const movement = isShort ? entryPrice - closePrice : closePrice - entryPrice;
  return movement / riskDistance;
}

function log(m) { console.log("  " + m); }

const learning = JSON.parse(fs.readFileSync(LEARNING, "utf8"));
const journal  = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));

console.log("");
console.log("=== BACKFILL realizedR -> learning.json " + (APPLY ? "[APPLY]" : "[DRY RUN]") + " ===");

if (learning.rBackfilledAt) {
  log("REFUSING: already backfilled at " + learning.rBackfilledAt + ".");
  log("Running again would DOUBLE-COUNT every R, and nothing afterwards could tell.");
  process.exit(3);
}

const closed = journal.filter(t => t && t.status === "CLOSED" && t.pnl !== null && t.pnl !== undefined);
log("closed fills in journal: " + closed.length);

const add = {};
let skippedNonSetup = 0, skippedNullR = 0;
for (const t of closed) {
  const setup = t.setup;
  if (!setup || NON_SETUP_NAMES.has(String(setup).trim().toUpperCase())) { skippedNonSetup++; continue; }
  const r = realizedRFromPrices(t.direction, t.entry, t.sl, t.closePrice);
  if (!Number.isFinite(r)) { skippedNullR++; continue; }
  add[setup] = add[setup] || { totalRealizedR: 0, rTrades: 0 };
  add[setup].totalRealizedR += r;
  add[setup].rTrades += 1;
}
log("skipped, name is not a setup : " + skippedNonSetup);
log("skipped, R not computable    : " + skippedNullR);
console.log("");

let anyMissing = false;
for (const [setup, a] of Object.entries(add)) {
  const s = learning.setupStats[setup];
  if (!s) { log("*** " + setup + " has R to add but NO setupStats row - skipping, nothing invented"); anyMissing = true; continue; }
  const fills = (s.wins ?? 0) + (s.losses ?? 0);
  log(setup.padEnd(20) + " fills " + String(fills).padEnd(3) +
      " rTrades " + String(a.rTrades).padEnd(3) +
      " totalR " + a.totalRealizedR.toFixed(3).padStart(8) +
      " avgR " + (a.totalRealizedR / a.rTrades).toFixed(3).padStart(7) +
      (fills !== a.rTrades ? "   (rTrades < fills - some R was not computable)" : ""));
}
if (anyMissing) log("(rows above marked *** are not written)");

if (!APPLY) {
  console.log("");
  log("DRY RUN. Nothing written. Re-run with --apply to back up and write.");
  process.exit(0);
}

// Backup, verified, before a single byte changes.
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
const bak = LEARNING + ".bak-rbackfill-" + stamp;
fs.copyFileSync(LEARNING, bak);
if (!fs.existsSync(bak) || fs.statSync(bak).size !== fs.statSync(LEARNING).size) {
  log("REFUSING: backup did not verify. Nothing written.");
  process.exit(1);
}
log("backed up -> " + path.basename(bak) + " (" + fs.statSync(bak).size + " bytes, size matches)");

// The three numbers that must not move, captured before.
const before = {};
for (const [k, s] of Object.entries(learning.setupStats)) before[k] = { w: s.wins, l: s.losses, p: s.totalPnl };

for (const [setup, a] of Object.entries(add)) {
  const s = learning.setupStats[setup];
  if (!s) continue;
  s.totalRealizedR = parseFloat(a.totalRealizedR.toFixed(4));
  s.rTrades = a.rTrades;
}
learning.rBackfilledAt = new Date().toISOString();

const tmp = LEARNING + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(learning, null, 2), "utf8");
JSON.parse(fs.readFileSync(tmp, "utf8"));          // must parse before it replaces anything
fs.renameSync(tmp, LEARNING);

const after = JSON.parse(fs.readFileSync(LEARNING, "utf8"));
let ok = true;
for (const [k, b] of Object.entries(before)) {
  const s = after.setupStats[k];
  if (!s || s.wins !== b.w || s.losses !== b.l || s.totalPnl !== b.p) { ok = false; log("*** " + k + " CHANGED and must not have"); }
}
console.log("");
log(ok ? "VERIFIED: wins, losses and totalPnl are identical for every setup." : "*** VERIFY FAILED - restore from " + path.basename(bak));
log("written. RESTART THE SERVER so it loads this instead of its in-memory copy.");
process.exit(ok ? 0 : 1);
