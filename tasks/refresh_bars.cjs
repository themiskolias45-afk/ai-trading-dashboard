'use strict';
/**
 * REFRESH THE BAR CACHE — but only in a natural window, and never on top of an open trade.
 *
 * WHY THIS EXISTS. Every replay in this project reads tasks/history/*.csv and NOTHING
 * refreshed them: export_mt5_history.py does the job and was referenced in one comment.
 * On 2026-08-22 the newest cached bar was 27-30 days old, which means the daily strategy
 * search re-tests identical data and its candidate count climbs while the evidence behind
 * it does not.
 *
 * WHY IT CANNOT SIMPLY RUN. The exporter opens a SECOND MetaTrader5 python client against
 * the same terminal. A conflict can knock the live bridge off IPC — the -10005 timeout
 * this project already has on record, and a bridge that logs "Could not connect after 6
 * attempts, giving up" and exits. With a position open that leaves it unmanaged: still
 * PROTECTED, because broker-side SL/TP survive, but nothing trailing or reconciling it.
 *
 * SO IT WAITS FOR THE NATURAL WINDOW. Run it as often as you like; it refuses on every
 * day the book is not flat and acts on the first day it is. That turns "remember to do
 * this when nothing is open" into something that does not need remembering.
 *
 * NOTHING IS DELETED. The existing CSVs are copied to tasks/history/bak-<stamp>/ before
 * the exporter runs, the result is verified, and a failed verification RESTORES from that
 * copy. A refresh that half-writes a file is worse than a stale one: stale bars give
 * yesterday's answer, truncated bars give a wrong one.
 *
 * Usage:
 *   node tasks/refresh_bars.cjs              dry run — says what it would do
 *   node tasks/refresh_bars.cjs --execute    act, if and only if the guards pass
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HISTORY = path.join(ROOT, "tasks", "history");
const EXECUTE = process.argv.includes("--execute");
const SERVER = process.env.SMARTENTRY_URL || "http://localhost:3001";
const SYMBOLS = ["XAUUSD", "BTCUSD", "SP500"];
const TIMEFRAMES = ["D1", "H4", "H1", "M15"];

// A bar file that comes back shorter than this fraction of its previous length is treated
// as a bad export and rolled back. A refresh should only ever ADD bars; a file that
// shrank means the exporter reached a terminal with less history, not that history
// changed.
const MIN_RETAINED_FRACTION = 0.95;

function log(line) { console.log(line); }

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, SERVER);
    const request = http.get(url, { timeout: 8000 }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (err) { resolve({ status: res.statusCode, json: null, raw: body.slice(0, 200) }); }
      });
    });
    request.on("timeout", () => { request.destroy(); reject(new Error("timeout")); });
    request.on("error", reject);
  });
}

function newestBar(symbol, timeframe) {
  const file = path.join(HISTORY, symbol + "_" + timeframe + ".csv");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  const stamp = Number(text.slice(text.lastIndexOf("\n") + 1).split(",")[0]);
  return Number.isFinite(stamp) ? stamp : null;
}

function fileSizes() {
  const sizes = {};
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const file = path.join(HISTORY, symbol + "_" + timeframe + ".csv");
      sizes[symbol + "_" + timeframe] = fs.existsSync(file) ? fs.statSync(file).size : 0;
    }
  }
  return sizes;
}

async function main() {
  log("refresh_bars [" + (EXECUTE ? "EXECUTE" : "DRY RUN") + "]  server=" + SERVER);

  // ── Guard 1: the server has to be answering, or the position check is blind ──
  let risk;
  try {
    risk = await getJson("/api/risk-status");
  } catch (err) {
    log("REFUSING: server not answering (" + err.message + "). Position state is unknowable.");
    process.exit(1);
  }
  if (!risk.json) { log("REFUSING: /api/risk-status did not return JSON."); process.exit(1); }
  if (risk.json.halted) {
    log("REFUSING: trading is halted. Fix that first — a halt is a reason to look at the "
      + "system, not a quiet window to run maintenance in.");
    process.exit(1);
  }

  // ── Guard 2: the book must be flat. This is the whole point of the tool ──
  let journal;
  try {
    journal = await getJson("/api/journal?limit=50");
  } catch (err) {
    log("REFUSING: journal unreachable (" + err.message + ").");
    process.exit(1);
  }
  const rows = journal.json && (journal.json.journal || journal.json);
  if (!Array.isArray(rows)) {
    log("REFUSING: journal shape unrecognised — cannot prove the book is flat, so assume it is not.");
    process.exit(1);
  }
  const open = rows.filter(row => row && row.status === "OPEN");
  if (open.length) {
    log("REFUSING: " + open.length + " position(s) open. The exporter opens a second MT5 "
      + "client and a conflict can drop the bridge, leaving these unmanaged:");
    for (const row of open) {
      log("    " + row.symbol + " " + row.direction + " " + row.volume + " since " + row.openTime);
    }
    log("  Nothing was changed. Run again when the book is flat — this tool is meant to be "
      + "run often and refuse most of the time.");
    process.exit(3);   // 3 = correctly refused, distinct from 1 = could not tell
  }
  log("  book is flat: 0 open positions");

  const before = {};
  for (const symbol of SYMBOLS) before[symbol] = newestBar(symbol, "D1");
  const ageDays = Object.values(before)
    .filter(Number.isFinite)
    .map(stamp => Math.floor((Date.now() / 1000 - stamp) / 86400));
  log("  newest cached D1 bar per symbol: "
    + SYMBOLS.map(s => s + " " + (before[s] ? new Date(before[s] * 1000).toISOString().slice(0, 10) : "none")).join(", "));
  if (ageDays.length) log("  oldest of those is " + Math.max(...ageDays) + " days old");

  if (!EXECUTE) {
    log("DRY RUN. Guards pass — would back up tasks/history, run export_mt5_history.py, "
      + "then verify. Re-run with --execute.");
    return;
  }

  // ── Back up before writing. Copy, never move: the originals stay put ──
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupDir = path.join(HISTORY, "bak-" + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const sizesBefore = fileSizes();
  let copied = 0;
  for (const name of Object.keys(sizesBefore)) {
    const source = path.join(HISTORY, name + ".csv");
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(backupDir, name + ".csv"));
    copied++;
  }
  log("  backed up " + copied + " file(s) -> " + path.relative(ROOT, backupDir));
  if (!copied) { log("REFUSING: nothing was backed up, so a rollback would be impossible."); process.exit(1); }

  // ── Export ──
  log("  running export_mt5_history.py …");
  try {
    const out = execFileSync("python", [path.join(ROOT, "tasks", "export_mt5_history.py")], {
      cwd: ROOT, encoding: "utf8", timeout: 900000, maxBuffer: 32 * 1024 * 1024,
    });
    for (const line of String(out).trim().split("\n").slice(-8)) log("    " + line);
  } catch (err) {
    log("  EXPORT FAILED: " + String(err.message || err).slice(0, 300));
    log("  originals are untouched in " + path.relative(ROOT, backupDir) + " and in place.");
    process.exit(1);
  }

  // ── Verify, and roll back rather than ship a truncated file ──
  const sizesAfter = fileSizes();
  const shrunk = Object.keys(sizesBefore).filter(name =>
    sizesBefore[name] > 0 && sizesAfter[name] < sizesBefore[name] * MIN_RETAINED_FRACTION);
  if (shrunk.length) {
    log("  VERIFY FAILED — these files shrank, which means a worse export, not new history:");
    for (const name of shrunk) log("    " + name + ": " + sizesBefore[name] + " -> " + sizesAfter[name]);
    for (const name of Object.keys(sizesBefore)) {
      const backup = path.join(backupDir, name + ".csv");
      if (fs.existsSync(backup)) fs.copyFileSync(backup, path.join(HISTORY, name + ".csv"));
    }
    log("  ROLLED BACK from " + path.relative(ROOT, backupDir) + ". The backup is kept.");
    process.exit(1);
  }

  let advanced = 0;
  for (const symbol of SYMBOLS) {
    const after = newestBar(symbol, "D1");
    const gainedDays = (after && before[symbol]) ? Math.round((after - before[symbol]) / 86400) : 0;
    if (after && before[symbol] && after > before[symbol]) advanced++;
    log("    " + symbol + " D1 newest "
      + (after ? new Date(after * 1000).toISOString().slice(0, 10) : "none")
      + (gainedDays > 0 ? "  (+" + gainedDays + " days)" : "  (unchanged)"));
  }
  if (!advanced) {
    log("  NOTE: no symbol advanced. The export succeeded but the terminal had nothing "
      + "newer — check that MT5 is logged in and its history is downloaded. Files are "
      + "intact and the backup is kept.");
  }
  log("done. Backup retained at " + path.relative(ROOT, backupDir) + " — nothing was deleted.");
}

main().catch(err => {
  console.error("refresh_bars failed: " + String(err.message || err).slice(0, 300));
  process.exit(1);
});
