// ATOMIC VERDICT LEDGER - turn the indicator's snapshot into a record.
//
// WHY THIS EXISTS, measured 2026-09-10.
// ATOMIC_ANALYST_V84 writes MQL5\Files\atomic_analyst\<SYMBOL>.json and OVERWRITES it
// every 60 seconds. In its first two days it produced roughly 8,600 verdicts across three
// symbols and two boxes and kept exactly SIX of them - the current one per file. There is
// no appendFile anywhere in atomic_feed_reader.cjs and no atomic *.jsonl on disk. A
// snapshot cannot be learned from: you cannot join it to an outcome, an agent cannot cite
// a hit rate from it, and the AI employee cannot appraise it. This makes it a record.
//
// IT IS THE HIGHEST SAMPLE-RATE EVIDENCE SOURCE IN THE SYSTEM. The binding constraint here
// is sample size - 16 closed trades ever - and this produces a scoreable observation every
// minute, on three symbols, on two boxes, risking nothing.
//
// WHAT IT MUST NEVER DO. Append rows and exit. It writes ONE file, it reads nothing that
// the engine writes, and nothing it produces is read by the signal path. The rows carry
// feedsTheGate:false from the indicator itself. This is a shadow ledger in the same sense
// as `shadow` in /api/learning: it accumulates alongside and gates nothing.
//
//   node tasks/atomic_ledger.cjs          append any new verdicts
//   node tasks/atomic_ledger.cjs --dry    report what it would append, write nothing
//
// Exit 0 always. An evidence feed that reddens a scheduled task buries the reds that matter.

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const DRY  = process.argv.includes("--dry");
const ROOT = path.join(__dirname, "..");
const LEDGER = path.join(ROOT, "tasks", "atomic_verdict_ledger.jsonl");
const HISTORY_DIR = path.join(ROOT, "tasks", "history");

// A verdict that has not changed is still evidence that it has not changed, but one row a
// minute of "still WAIT" is noise. A row is written when the verdict CHANGES, or when this
// many minutes have passed since the last row for that key - so a symbol parked in WAIT
// for a week still yields scoreable samples instead of a single row and a silence.
const HEARTBEAT_MIN = 60;
const TAIL_BYTES    = 512 * 1024;   // enough tail to find the last row per key
const MAX_BYTES     = 256 * 1024;   // a verdict file is ~1.5KB; anything near this is not one
const MAX_AGE_MIN   = 30;           // older than this is recorded, but flagged stale

function box() { return (os.hostname() || "unknown").toUpperCase(); }

function terminalFileDirs() {
  const base = path.join(os.homedir(), "AppData", "Roaming", "MetaQuotes", "Terminal");
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(base); } catch { return out; }
  for (const entry of entries) {
    const dir = path.join(base, entry, "MQL5", "Files", "atomic_analyst");
    try { if (fs.statSync(dir).isDirectory()) out.push({ terminal: entry, dir }); }
    catch { /* this terminal has no atomic feed - normal */ }
  }
  return out;
}

// LAST STATE COMES FROM THE LEDGER ITSELF, not from a side-car state file.
// A separate state file is one more thing that can desync from the data it describes, and
// this repo has paid for that twice. The tail of the ledger IS the state.
function lastRowsByKey() {
  const out = new Map();
  let raw = "";
  try {
    const size = fs.statSync(LEDGER).size;
    const fd = fs.openSync(LEDGER, "r");
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString("utf8");
  } catch { return out; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  // Drop a partial first line when the tail started mid-row.
  for (let i = (raw.length && raw[0] !== "{" ? 1 : 0); i < lines.length; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row && row.key) out.set(row.key, row);
  }
  return out;
}

// Price at verdict time. The indicator publishes ticket.entry only when it is NOT on WAIT,
// so a WAIT row has no price of its own - and a WAIT row with no price cannot be scored,
// which would silently drop the majority of the sample. The fallback is the last closed
// M15 bar this repo already keeps for that symbol. Which source was used is RECORDED, so a
// later analysis can exclude the fallback rows instead of discovering them by surprise.
function priceFor(rec) {
  const fromTicket = rec && rec.ticket && Number(rec.ticket.entry);
  if (Number.isFinite(fromTicket) && fromTicket > 0) return { price: fromTicket, priceSource: "ticket" };
  const csv = path.join(HISTORY_DIR, String(rec.symbol) + "_M15.csv");
  try {
    const size = fs.statSync(csv).size;
    const fd = fs.openSync(csv, "r");
    const start = Math.max(0, size - 4096);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const parts = lines[i].split(",");
      const close = Number(parts[4]);
      if (Number.isFinite(close) && close > 0) return { price: close, priceSource: "m15close" };
    }
  } catch { /* no history for this symbol - the row is written priceless and unscoreable */ }
  return { price: null, priceSource: "none" };
}

function main() {
  const dirs = terminalFileDirs();
  console.log("");
  console.log("=== ATOMIC VERDICT LEDGER " + (DRY ? "[DRY] " : "") + "on " + box() + " ===");
  if (!dirs.length) {
    console.log("  no atomic_analyst folder in any terminal - indicator not attached yet");
    return 0;
  }

  const last = lastRowsByKey();
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [];

  for (const t of dirs) {
    let files = [];
    try { files = fs.readdirSync(t.dir).filter((f) => f.toLowerCase().endsWith(".json")); }
    catch (e) { console.log("  " + t.terminal.slice(0, 8) + ": unreadable - " + e.message); continue; }

    for (const f of files) {
      const full = path.join(t.dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > MAX_BYTES) { console.log("  " + f + ": " + stat.size + " bytes, not a verdict file"); continue; }

      let rec;
      // A half-written file is normal - the indicator may be mid-write. Skip and let the
      // next run take it rather than reporting a failure.
      try { rec = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
      if (!rec || rec.source !== "ATOMIC_ANALYST_V84" || !rec.symbol) continue;

      const key = box() + "|" + t.terminal + "|" + rec.symbol;
      const prev = last.get(key);
      const ageMin = Number.isFinite(rec.generatedAtEpoch)
        ? (nowSec - rec.generatedAtEpoch) / 60 : null;

      // The identity of a verdict, for change detection. Confidence is deliberately NOT in
      // it: it moves by a percent constantly and would make every run a "change", which is
      // how a change-triggered ledger becomes a per-minute dump.
      const sig = [rec.direction, rec.finalConsensus, String(rec.mtfAligned),
                   (rec.trail && rec.trail.direction) || ""].join("/");
      const changed = !prev || prev.sig !== sig;
      const quietMin = prev ? (nowSec - (prev.epoch || 0)) / 60 : Infinity;
      const heartbeat = !changed && quietMin >= HEARTBEAT_MIN;
      if (!changed && !heartbeat) continue;

      const { price, priceSource } = priceFor(rec);
      const row = {
        id: box() + "|" + rec.symbol + "|" + (rec.generatedAtEpoch || nowSec),
        key,
        box: box(),
        terminal: t.terminal,
        symbol: rec.symbol,
        timeframe: rec.timeframe || null,
        account: rec.account || null,
        epoch: rec.generatedAtEpoch || nowSec,
        at: new Date((rec.generatedAtEpoch || nowSec) * 1000).toISOString(),
        reason: changed ? "change" : "heartbeat",
        sig,
        verdict: rec.verdict || null,
        direction: rec.direction || null,
        finalConsensus: rec.finalConsensus || null,
        decisionAgreesWithConsensus: rec.decisionAgreesWithConsensus ?? null,
        confidence: Number.isFinite(rec.confidence) ? rec.confidence : null,
        mtfAligned: rec.mtfAligned ?? null,
        spreadOk: rec.spreadOk ?? null,
        trailDirection: (rec.trail && rec.trail.direction) || null,
        dominance: rec.dominance || null,
        consensus: rec.consensus || null,
        mtf: rec.mtf || null,
        rsi: rec.indicators ? rec.indicators.rsi : null,
        adx: rec.indicators ? rec.indicators.adx : null,
        atr: rec.indicators ? rec.indicators.atr : null,
        spreadPoints: rec.indicators ? rec.indicators.spreadPoints : null,
        price,
        priceSource,
        stale: ageMin === null || ageMin > MAX_AGE_MIN,
        ageMinutesAtWrite: ageMin === null ? null : Number(ageMin.toFixed(2)),
        // Carried through from the indicator so no reader of this file has to go and check
        // whether these rows are allowed near the decision path. They are not.
        feedsTheGate: false,
        writtenAt: new Date().toISOString(),
      };
      rows.push(row);
      last.set(key, row);

      console.log("  " + String(row.symbol).padEnd(9) +
        " " + String(row.direction).padEnd(5) +
        " cons " + String(row.finalConsensus).padEnd(5) +
        " conf " + String(row.confidence ?? "?").padStart(5) +
        " trail " + String(row.trailDirection).padEnd(5) +
        " px " + (row.price === null ? "none" : String(row.price)) +
        " (" + row.priceSource + ")  " + row.reason +
        (row.stale ? "  STALE" : ""));
    }
  }

  if (!rows.length) { console.log("  nothing new - no verdict changed and no heartbeat due"); return 0; }
  if (DRY) { console.log("\n  [DRY] would append " + rows.length + " row(s)"); return 0; }

  // APPEND ONLY. Never rewrite this file: it is the sample, and the sample is the thing
  // this system is short of. One write, with a newline per row.
  try {
    fs.appendFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch (e) {
    console.log("  APPEND FAILED: " + e.message);
    return 0;
  }
  let total = 0;
  try { total = fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean).length; } catch {}
  console.log("");
  console.log("  appended " + rows.length + " row(s) -> tasks/atomic_verdict_ledger.jsonl (" + total + " total)");
  return 0;
}

process.exit(main());
