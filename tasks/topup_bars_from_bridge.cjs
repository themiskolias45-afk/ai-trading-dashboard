'use strict';
/**
 * TOP UP THE RESEARCH BARS FROM THE BRIDGE PUSH — no second MT5 client, no flat book needed.
 *
 * WHY THIS EXISTS. tasks/history/*.csv is what every replay, walk-forward and the nightly
 * strategy search reads. The only thing that refreshed it was refresh_bars.cjs ->
 * export_mt5_history.py, which REFUSES whenever a position is open — correctly, because
 * the exporter opens a SECOND MetaTrader5 python client against the same terminal and the
 * next initialize() breaks the connection the live bridge is holding. Measured 2026-08-24:
 * the cache had been frozen at 2026-07-24/26 for 29 days, refusing on every single run,
 * because XAUUSD had been open 13 days and SP500 5 days. The hourly schedule added
 * 2026-08-23 cannot help — it waits for a flat book, and a 13-day position guarantees the
 * book is never flat. The coverage audit's only RED said exactly this: "the strategy
 * search is re-testing identical data".
 *
 * THE BARS WERE ALREADY IN THE BUILDING. The MT5 bridge POSTs its candles to the server on
 * every cycle and GET /api/mt5/candles/raw serves them back: per asset d1 600, h4 400,
 * h1 1200, each with opens/highs/lows/closes/volumes/times — exactly the CSV schema
 * `time,open,high,low,close,tick_volume`. Reading that is an HTTP GET. It opens no MT5
 * client, so it is safe with any number of positions open, which is the whole point.
 *
 * VERIFIED BEFORE THIS WAS WRITTEN (2026-08-24), not assumed:
 *   - 571 overlapping BTCUSD D1 bars matched the CSV to the digit, so the timestamp basis
 *     and the OHLC basis are the same. These are the same broker's bars by the same clock.
 *   - all 9 series (3 symbols x D1/H4/H1) overlap the CSV tail, so a top-up leaves no hole.
 *   - the CSV's own final bar was PARTIAL: 2026-07-26 held h=64776.04 c=64755.84 v=42757
 *     where the closed bar is h=64928.18 c=64644.95 v=57269. The exporter had caught that
 *     day mid-formation and froze it. That is why this tool OVERWRITES overlapping bars
 *     instead of only appending past the end — an append-only merge would have preserved a
 *     wrong bar forever.
 *
 * M15 IS NOT COVERED. The bridge pushes d1/h4/h1 only. M15 still needs the exporter and a
 * flat book. Do not report the bar cache as fixed on the strength of this tool.
 *
 * NOTHING IS DELETED AND NOTHING IS DROPPED. Every existing CSV row survives: the merge
 * keeps the CSV row set and overlays the API bars on top of it, so a bar the exporter has
 * and the bridge never pushed is retained. Row counts can only stay level or grow, which
 * is what the verification asserts. All of tasks/history is copied to
 * tasks/history/bak-<stamp>/ before a single byte is written, and any file that shrinks
 * triggers a restore from that copy.
 *
 * Usage:
 *   node tasks/topup_bars_from_bridge.cjs              dry run — says what it would do
 *   node tasks/topup_bars_from_bridge.cjs --execute    write the merged files
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const HISTORY = path.join(ROOT, "tasks", "history");
const EXECUTE = process.argv.includes("--execute");
const SERVER = process.env.SMARTENTRY_URL || "http://localhost:3001";

// asset key in the API payload -> the broker symbol its CSVs are named for.
const ASSETS = { btc: "BTCUSD", gold: "XAUUSD", spx: "SP500" };
// API bar-series key -> CSV filename suffix. M15 is absent by design: the bridge does not
// push it, and inventing it from a coarser series would be fabricated history.
const TIMEFRAMES = { d1: "D1", h4: "H4", h1: "H1" };

const CSV_HEADER = "time,open,high,low,close,tick_volume";
// The exporter writes prices to five decimals for every instrument. Matching it keeps the
// file uniform, so a later diff shows new bars and not a reformat of the whole history.
const PRICE_DECIMALS = 5;
// A bridge that has not pushed in this long is not reporting, and its cache is whatever it
// last managed to send. Top up from a live feed or not at all.
const MAX_PUSH_AGE_MS = 15 * 60 * 1000;

function log(line) { console.log(line); }

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, SERVER);
    const request = http.get(url, { timeout: 15000 }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, json: parsed, raw: body.slice(0, 200) });
      });
    });
    request.on("timeout", () => { request.destroy(); reject(new Error("timeout after 15s")); });
    request.on("error", reject);
  });
}

/**
 * Fetch and insist on a 200. A 401 body parses as clean JSON and every field then reads as
 * absent — that is precisely how the daily plan wrote null prices for 22 days. Check the
 * status, never just the shape.
 */
async function getOk(pathname) {
  const response = await getJson(pathname);
  if (response.status !== 200) {
    throw new Error(pathname + " returned HTTP " + response.status + " " + response.raw);
  }
  if (!response.json) throw new Error(pathname + " did not return JSON: " + response.raw);
  return response.json;
}

function csvPath(symbol, timeframe) {
  return path.join(HISTORY, symbol + "_" + timeframe + ".csv");
}

/** Read a CSV into time -> original line text, so untouched rows are rewritten verbatim. */
function readCsv(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return null;
  const lines = text.split("\n");
  const rows = new Map();
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const stamp = Number(trimmed.split(",")[0]);
    if (Number.isFinite(stamp)) rows.set(stamp, trimmed);
  }
  return rows;
}

function formatBar(time, open, high, low, close, volume) {
  const price = value => Number(value).toFixed(PRICE_DECIMALS);
  return [time, price(open), price(high), price(low), price(close), Math.round(Number(volume))].join(",");
}

/**
 * Turn one API bar series into time -> line, dropping the final bar.
 * The last bar of every series is the one still forming — the API's newest D1 bar is
 * today's, mid-session. Writing it is how the CSV got a wrong 2026-07-26 in the first
 * place. It costs nothing to skip: the next run picks it up once it has closed.
 */
function closedBarsFromApi(series) {
  const { times, opens, highs, lows, closes, volumes } = series;
  const lengths = [times, opens, highs, lows, closes, volumes].map(a => (Array.isArray(a) ? a.length : -1));
  if (lengths.some(n => n < 0)) return { error: "series is missing one of times/opens/highs/lows/closes/volumes" };
  if (new Set(lengths).size !== 1) return { error: "series arrays disagree in length: " + lengths.join("/") };
  if (times.length < 2) return { error: "series has " + times.length + " bar(s), too few to drop the forming one" };

  const bars = new Map();
  for (let i = 0; i < times.length - 1; i++) {
    const time = Number(times[i]);
    const values = [opens[i], highs[i], lows[i], closes[i], volumes[i]].map(Number);
    if (!Number.isFinite(time) || values.some(v => !Number.isFinite(v))) {
      return { error: "non-numeric bar at index " + i };
    }
    bars.set(time, formatBar(time, values[0], values[1], values[2], values[3], values[4]));
  }
  return { bars, droppedForming: Number(times[times.length - 1]) };
}

function isoDay(stamp) {
  return new Date(stamp * 1000).toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
  log("topup_bars_from_bridge [" + (EXECUTE ? "EXECUTE" : "DRY RUN") + "]  server=" + SERVER);
  log("  reads GET /api/mt5/candles/raw — no MT5 client is opened, so open positions are fine.");

  if (!fs.existsSync(HISTORY)) {
    log("REFUSING: " + path.relative(ROOT, HISTORY) + " does not exist.");
    process.exit(1);
  }

  // ── Both payloads, both insisted on 200 ──────────────────────────────────
  let summary, raw;
  try {
    summary = await getOk("/api/mt5/candles");       // provenance: which source is live
    raw = await getOk("/api/mt5/candles/raw");       // the OHLCV itself (localhost only)
  } catch (err) {
    log("REFUSING: " + String(err.message || err));
    log("  Nothing was changed. Is the server up, and is this running on the box itself?");
    process.exit(1);
  }
  if (!raw.assets || typeof raw.assets !== "object") {
    log("REFUSING: /api/mt5/candles/raw has no assets object — shape unrecognised.");
    process.exit(1);
  }

  // ── Plan every series before touching anything ───────────────────────────
  const planned = [];   // { symbol, timeframe, file, merged, added, corrected, newest }
  const skipped = [];   // { series, why }

  for (const [assetKey, symbol] of Object.entries(ASSETS)) {
    const asset = raw.assets[assetKey];
    const source = (summary.sources || {})[assetKey] || {};

    if (!asset || !asset.bars) { skipped.push({ series: symbol, why: "absent from the raw payload" }); continue; }

    // Writing one instrument's bars into another's file would corrupt history in a way no
    // later run could detect. Refuse rather than trust the key.
    const reported = asset.symbol || source.brokerSymbol;
    if (reported && reported !== symbol) {
      skipped.push({ series: symbol, why: "payload reports symbol '" + reported + "' — refusing to write it into " + symbol + " files" });
      continue;
    }
    if (Number.isFinite(asset.ageMs) && asset.ageMs > MAX_PUSH_AGE_MS) {
      skipped.push({ series: symbol, why: "bridge push is " + Math.round(asset.ageMs / 60000) + " min old (limit " + (MAX_PUSH_AGE_MS / 60000) + ") — the bridge is not reporting" });
      continue;
    }
    if (source.activeSource && source.activeSource !== "mt5") {
      log("  NOTE " + symbol + ": live source is '" + source.activeSource + "', not mt5. The cached bars are still the "
        + "bridge's own MT5 bars, but they may be stale — expect few or no new rows.");
    }

    for (const [seriesKey, timeframe] of Object.entries(TIMEFRAMES)) {
      const name = symbol + "_" + timeframe;
      const series = asset.bars[seriesKey];
      if (!series) { skipped.push({ series: name, why: "timeframe absent from the payload" }); continue; }

      const parsed = closedBarsFromApi(series);
      if (parsed.error) { skipped.push({ series: name, why: parsed.error }); continue; }

      const file = csvPath(symbol, timeframe);
      const existing = readCsv(file);
      if (!existing || !existing.size) { skipped.push({ series: name, why: "CSV missing or empty — this tool tops up, it does not create history" }); continue; }

      const apiTimes = [...parsed.bars.keys()].sort((a, b) => a - b);
      const csvTimes = [...existing.keys()].sort((a, b) => a - b);
      const csvNewest = csvTimes[csvTimes.length - 1];

      // If the API window opens AFTER the CSV ends, merging leaves a hole between them, and
      // a replay reading across that hole gets a wrong answer rather than a stale one.
      if (apiTimes[0] > csvNewest) {
        skipped.push({
          series: name,
          why: "GAP — API starts " + isoDay(apiTimes[0]) + " but the CSV ends " + isoDay(csvNewest)
            + ". Merging would leave a hole; this needs the full exporter on a flat book.",
        });
        continue;
      }

      // Overlay, never replace: keep every CSV row, let the API correct the ones it also
      // has. A bar the exporter holds and the bridge never pushed survives untouched.
      const merged = new Map(existing);
      let added = 0, corrected = 0;
      for (const [time, line] of parsed.bars) {
        if (!merged.has(time)) { merged.set(time, line); added++; }
        else if (merged.get(time) !== line) { merged.set(time, line); corrected++; }
      }

      const mergedTimes = [...merged.keys()].sort((a, b) => a - b);
      planned.push({
        symbol, timeframe, name, file, merged, mergedTimes, added, corrected,
        wasNewest: csvNewest,
        nowNewest: mergedTimes[mergedTimes.length - 1],
        rowsBefore: existing.size,
        rowsAfter: merged.size,
      });
    }
  }

  // ── Report the plan ──────────────────────────────────────────────────────
  log("");
  for (const p of planned) {
    const change = p.added || p.corrected
      ? "+" + p.added + " new, " + p.corrected + " corrected -> newest " + isoDay(p.nowNewest)
      : "up to date (newest " + isoDay(p.nowNewest) + ")";
    log("  " + p.name.padEnd(14) + " " + p.rowsBefore + " rows, " + change);
  }
  for (const s of skipped) log("  SKIPPED " + s.series.padEnd(14) + " " + s.why);

  const changing = planned.filter(p => p.added || p.corrected);
  log("");
  log("  " + planned.length + " series readable, " + changing.length + " with changes, " + skipped.length + " skipped.");
  log("  M15 is not covered by this tool — the bridge does not push it. It still needs "
    + "export_mt5_history.py on a flat book.");

  if (!changing.length) {
    log("Nothing to write. Files are untouched.");
    return;
  }
  if (!EXECUTE) {
    log("DRY RUN. Re-run with --execute to back up tasks/history and write the merged files.");
    return;
  }

  // ── Back up everything in tasks/history before writing one byte ──────────
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupDir = path.join(HISTORY, "bak-" + stamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const allCsvs = fs.readdirSync(HISTORY).filter(f => f.toLowerCase().endsWith(".csv"));
  const sizesBefore = {};
  let copied = 0;
  for (const fileName of allCsvs) {
    const source = path.join(HISTORY, fileName);
    if (!fs.statSync(source).isFile()) continue;
    const target = path.join(backupDir, fileName);
    fs.copyFileSync(source, target);
    // Verify the copy landed and is the same size before it is allowed to count as a backup.
    if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size) {
      log("REFUSING: backup of " + fileName + " did not verify. Nothing has been written.");
      process.exit(1);
    }
    sizesBefore[fileName] = fs.statSync(source).size;
    copied++;
  }
  if (!copied) { log("REFUSING: nothing was backed up, so a rollback would be impossible."); process.exit(1); }
  log("  backed up " + copied + " file(s) -> " + path.relative(ROOT, backupDir));

  // ── Write ────────────────────────────────────────────────────────────────
  const written = [];
  try {
    for (const p of changing) {
      const body = p.mergedTimes.map(time => p.merged.get(time)).join("\n");
      fs.writeFileSync(p.file, CSV_HEADER + "\n" + body + "\n", "utf8");
      written.push(p);
    }
  } catch (err) {
    log("  WRITE FAILED: " + String(err.message || err).slice(0, 300));
    for (const fileName of Object.keys(sizesBefore)) {
      fs.copyFileSync(path.join(backupDir, fileName), path.join(HISTORY, fileName));
    }
    log("  ROLLED BACK from " + path.relative(ROOT, backupDir) + ". The backup is kept.");
    process.exit(1);
  }

  // ── Verify: a top-up adds rows. Anything that shrank is a bad write ──────
  const shrunk = [];
  for (const p of written) {
    const rows = readCsv(p.file);
    const count = rows ? rows.size : 0;
    if (count < p.rowsBefore) shrunk.push(p.name + ": " + p.rowsBefore + " -> " + count + " rows");
  }
  if (shrunk.length) {
    log("  VERIFY FAILED - these files lost rows:");
    for (const line of shrunk) log("    " + line);
    for (const fileName of Object.keys(sizesBefore)) {
      fs.copyFileSync(path.join(backupDir, fileName), path.join(HISTORY, fileName));
    }
    log("  ROLLED BACK from " + path.relative(ROOT, backupDir) + ". The backup is kept.");
    process.exit(1);
  }

  log("");
  for (const p of written) {
    log("    " + p.name.padEnd(14) + " " + p.rowsBefore + " -> " + p.rowsAfter + " rows, newest "
      + isoDay(p.wasNewest) + " -> " + isoDay(p.nowNewest));
  }
  log("done. " + written.length + " file(s) written. Backup retained at "
    + path.relative(ROOT, backupDir) + " - nothing was deleted.");
}

main().catch(err => {
  console.error("topup_bars_from_bridge failed: " + String(err.message || err).slice(0, 300));
  process.exit(1);
});
