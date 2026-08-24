'use strict';
/**
 * PERSIST THE BARS THE BRIDGE IS ALREADY PUSHING.
 *
 * WHY THIS EXISTS. tasks/refresh_bars.cjs refuses to run the MT5 exporter whenever a
 * position is open, because export_mt5_history.py opens a SECOND MetaTrader5 client and
 * a conflict can drop the live bridge off IPC. That refusal is correct. What was missing
 * is any upper bound on it: measured 2026-08-24, refresh_bars had refused 8 runs out of 8,
 * every one naming the same two positions, and XAUUSD #1742893638 had been open for 13
 * days. A guard that waits for a flat book cannot clear while a position is held for
 * weeks, so "run it often and it acts on the first flat day" had quietly become "never".
 * Every CSV in tasks/history was frozen at 2026-07-26 and the daily strategy search said
 * so in its own output: "SAME BARS AS THE LAST RUN ... re-tested IDENTICAL DATA".
 *
 * THE POINT: NO SECOND MT5 CLIENT IS NEEDED. mt5_bridge.py::push_candles already sends
 * native D1/H4/H1 for all three symbols every 5 minutes, from the client that is ALREADY
 * connected, and server/index.js holds them in memory. This reads that memory back out of
 * GET /api/mt5/candles/raw and appends what is new. It opens no terminal, touches no
 * broker connection, and is therefore safe with positions open — which is the entire
 * reason it can run when the exporter cannot.
 *
 * WHAT IT WILL NOT DO.
 *   - It never overwrites. The push carries 600 D1 bars; the archives hold 1290-1793.
 *     A whole-file write would silently truncate years of history, which is exactly what
 *     refresh_bars.cjs's MIN_RETAINED_FRACTION rollback exists to catch. This only ever
 *     APPENDS rows strictly newer than the last one already on disk.
 *   - It never bridges a gap. If the oldest incoming bar is newer than the newest cached
 *     bar, the two series do not overlap and appending would punch a HOLE that a replay
 *     would walk straight through without noticing. A hole is worse than staleness:
 *     stale bars give yesterday's answer, a discontinuous series gives a wrong one that
 *     looks right. That series is refused by name and the gap is printed.
 *     Known live case: H1. 400 pushed bars reach back ~23 calendar days against a cache
 *     that ends ~30 days ago. H1 will refuse here until either the cache is closed by the
 *     exporter during a genuinely flat book, or BAR_COUNT_BY_TIMEFRAME["h1"] is raised in
 *     mt5_bridge.py -- and that second option is a SIGNAL-PATH change, because more H1
 *     bars reseed EMA200 and can move H1 confidence. It needs its own before/after
 *     comparison of /api/signals and is deliberately not bundled in here.
 *   - It never invents a column. The CSV format is time,open,high,low,close,tick_volume.
 *     If a series arrives without opens or without times, it is refused rather than
 *     completed with a guess.
 *   - It never writes a half-formed bar. copy_rates_from_pos(..., 0, N) includes the bar
 *     currently forming, and a partial day written into history is a wrong row, not a
 *     late one. Only bars whose period has fully elapsed are eligible.
 *
 * Usage:
 *   node tasks/persist_bars.cjs              dry run -- says exactly what it would append
 *   node tasks/persist_bars.cjs --execute    write, atomically, verifying after each file
 *
 * Exit codes: 0 = wrote or already current. 3 = nothing written because every series was
 * refused for a stated reason (the refresh_bars convention: a refusal is not a crash).
 * 1 = could not tell (server unreachable, bad payload, failed verification).
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const HISTORY = path.join(ROOT, "tasks", "history");
const EXECUTE = process.argv.includes("--execute");
const SERVER = process.env.SMARTENTRY_URL || "http://localhost:3001";

const CSV_HEADER = "time,open,high,low,close,tick_volume";

// How many seconds one bar of each timeframe covers. Used to decide whether the newest
// bar has actually closed; a bar whose period has not elapsed is still being written to
// by the market and must not be persisted.
const PERIOD_SECONDS = { d1: 86400, h4: 14400, h1: 3600 };

// The exporter writes prices at five decimals and volumes as integers. Matching it
// exactly matters: these files are concatenated with rows the exporter wrote, and a
// format change mid-file would land in whatever parses them next.
const PRICE_DECIMALS = 5;

// Timeframe key in the API payload -> filename suffix on disk.
const TF_SUFFIX = { d1: "D1", h4: "H4", h1: "H1" };

function log(line) { console.log(line); }

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, SERVER);
    const request = http.get(url, { timeout: 15000 }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, json: null, raw: body.slice(0, 200) }); }
      });
    });
    request.on("timeout", () => { request.destroy(new Error("timeout after 15s")); });
    request.on("error", reject);
  });
}

/**
 * Last bar timestamp and row count already on disk, without holding the whole file in
 * memory as parsed rows. These files reach 41,000 rows and 6MB; only the tail matters.
 * Returns null when the file is absent or has no data rows — both are refusals, never a
 * reason to create a short file that would look like a complete history.
 */
function readCsvTail(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) return null;
  const header = lines[0].trim();
  const lastTime = Number(lines[lines.length - 1].split(",")[0]);
  if (!Number.isFinite(lastTime)) return null;
  return {
    header,
    lastTime,
    rows: lines.length - 1,
    endsWithNewline: text.endsWith("\n"),
    bytes: Buffer.byteLength(text),
  };
}

/**
 * Turn one timeframe of the in-memory cache into CSV rows, or explain why it cannot be.
 * Every rejection here is a named string, never a silent empty array — an unexplained
 * "0 rows appended" is indistinguishable from "already up to date", and those two need
 * very different responses.
 */
function buildRows(bars, timeframe, nowSec) {
  if (!bars) return { error: "series absent from the payload" };
  const { opens, highs, lows, closes, volumes, times } = bars;
  if (!Array.isArray(times) || !times.length) {
    return { error: "no bar timestamps — bridge predates the times field, cannot place these rows in time" };
  }
  if (!Array.isArray(opens) || !opens.length) {
    return { error: "no open prices — bridge has not restarted since opens were added; refusing rather than inventing the column" };
  }
  const n = closes.length;
  if (opens.length !== n || highs.length !== n || lows.length !== n || times.length !== n) {
    return { error: `ragged series: opens=${opens.length} highs=${highs.length} lows=${lows.length} closes=${n} times=${times.length}` };
  }
  const period = PERIOD_SECONDS[timeframe];
  if (!period) return { error: `unknown timeframe ${timeframe}` };

  const hasVolumes = Array.isArray(volumes) && volumes.length === n;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const barOpenTime = times[i];
    // Drop the bar that has not finished. The market is still writing it.
    if (barOpenTime + period > nowSec) continue;
    const volume = hasVolumes ? Math.round(volumes[i]) : 0;
    rows.push({
      time: barOpenTime,
      line: [
        barOpenTime,
        opens[i].toFixed(PRICE_DECIMALS),
        highs[i].toFixed(PRICE_DECIMALS),
        lows[i].toFixed(PRICE_DECIMALS),
        closes[i].toFixed(PRICE_DECIMALS),
        volume,
      ].join(","),
    });
  }
  if (!rows.length) return { error: "every bar in the series is still forming" };
  // Ascending and unique, or the seam check below is meaningless.
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].time <= rows[i - 1].time) {
      return { error: `payload not strictly ascending at index ${i} (${rows[i - 1].time} -> ${rows[i].time})` };
    }
  }
  return { rows };
}

/**
 * Append rows to a CSV without ever risking the existing content. Writes the ORIGINAL
 * bytes plus the new ones to a temp file in the same directory, verifies the result, then
 * renames over the original — so an interrupted run leaves the original untouched rather
 * than a half-written history file.
 */
function appendVerified(file, tail, newLines) {
  const tmp = file + ".tmp-persist";
  const original = fs.readFileSync(file, "utf8");
  const joiner = tail.endsWithNewline ? "" : "\n";
  const next = original + joiner + newLines.join("\n") + "\n";
  fs.writeFileSync(tmp, next, "utf8");

  const check = readCsvTail(tmp);
  if (!check) { fs.unlinkSync(tmp); throw new Error("temp file unreadable after write"); }
  if (check.rows !== tail.rows + newLines.length) {
    fs.unlinkSync(tmp);
    throw new Error(`row count wrong: expected ${tail.rows + newLines.length}, got ${check.rows}`);
  }
  if (check.bytes < tail.bytes) {
    fs.unlinkSync(tmp);
    throw new Error(`file SHRANK: ${tail.bytes} -> ${check.bytes} bytes`);
  }
  if (check.header !== CSV_HEADER) {
    fs.unlinkSync(tmp);
    throw new Error(`header changed: "${check.header}"`);
  }
  fs.renameSync(tmp, file);
  return check;
}

async function main() {
  log(`persist_bars [${EXECUTE ? "EXECUTE" : "DRY RUN"}]  server=${SERVER}`);

  let payload;
  try {
    payload = await getJson("/api/mt5/candles/raw");
  } catch (err) {
    log(`CANNOT TELL: server unreachable at ${SERVER} (${err.message}). Nothing was changed.`);
    process.exit(1);
  }
  if (payload.status !== 200 || !payload.json?.assets) {
    log(`CANNOT TELL: /api/mt5/candles/raw returned HTTP ${payload.status}. Nothing was changed.`);
    process.exit(1);
  }

  const assets = payload.json.assets;
  const assetKeys = Object.keys(assets);
  if (!assetKeys.length) {
    log("CANNOT TELL: the MT5 candle cache is empty — no bridge has pushed since this server started.");
    process.exit(1);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let appendedFiles = 0, appendedRows = 0, refused = 0, current = 0;

  for (const assetKey of assetKeys) {
    const entry = assets[assetKey];
    const symbol = entry?.symbol;
    if (!symbol) { log(`  ${assetKey}: no broker symbol in the payload — skipped`); refused++; continue; }

    for (const timeframe of Object.keys(TF_SUFFIX)) {
      const label = `${symbol}_${TF_SUFFIX[timeframe]}`;
      const file = path.join(HISTORY, `${label}.csv`);

      const tail = readCsvTail(file);
      if (!tail) {
        log(`  ${label.padEnd(13)} REFUSED — no existing CSV to extend. A file created from ${
          ""}600 pushed bars would look like a full history and is not one.`);
        refused++;
        continue;
      }
      if (tail.header !== CSV_HEADER) {
        log(`  ${label.padEnd(13)} REFUSED — unexpected header "${tail.header}"`);
        refused++;
        continue;
      }

      const built = buildRows(entry.bars?.[timeframe], timeframe, nowSec);
      if (built.error) {
        log(`  ${label.padEnd(13)} REFUSED — ${built.error}`);
        refused++;
        continue;
      }

      const oldestIncoming = built.rows[0].time;
      // THE GAP GUARD. The incoming window must reach back to at least the last bar
      // already stored, or the join is a hole rather than a continuation.
      if (oldestIncoming > tail.lastTime) {
        const gapDays = ((oldestIncoming - tail.lastTime) / 86400).toFixed(1);
        log(`  ${label.padEnd(13)} REFUSED — GAP. Cache ends ${new Date(tail.lastTime * 1000).toISOString().slice(0, 16)}`
          + `, oldest pushed bar is ${new Date(oldestIncoming * 1000).toISOString().slice(0, 16)}`
          + ` — appending would leave a ${gapDays}d hole in the series.`);
        refused++;
        continue;
      }

      const fresh = built.rows.filter(r => r.time > tail.lastTime);
      if (!fresh.length) {
        log(`  ${label.padEnd(13)} already current (${tail.rows} rows, newest ${
          new Date(tail.lastTime * 1000).toISOString().slice(0, 16)})`);
        current++;
        continue;
      }

      const newestFresh = fresh[fresh.length - 1].time;
      const span = `${new Date(fresh[0].time * 1000).toISOString().slice(0, 16)} -> ${
        new Date(newestFresh * 1000).toISOString().slice(0, 16)}`;

      if (!EXECUTE) {
        log(`  ${label.padEnd(13)} would append ${String(fresh.length).padStart(5)} rows  ${span}  (${tail.rows} -> ${tail.rows + fresh.length})`);
        appendedFiles++; appendedRows += fresh.length;
        continue;
      }

      try {
        const after = appendVerified(file, tail, fresh.map(r => r.line));
        log(`  ${label.padEnd(13)} appended ${String(fresh.length).padStart(5)} rows  ${span}  (${tail.rows} -> ${after.rows}) VERIFIED`);
        appendedFiles++; appendedRows += fresh.length;
      } catch (err) {
        log(`  ${label.padEnd(13)} WRITE FAILED — ${err.message}. Original left untouched.`);
        refused++;
      }
    }
  }

  log("");
  log(`${EXECUTE ? "appended" : "would append"} ${appendedRows} row(s) across ${appendedFiles} file(s); ${current} already current; ${refused} refused`);
  if (!EXECUTE && appendedFiles) log("Dry run — nothing was written. Re-run with --execute.");
  if (!appendedFiles && !current && refused) process.exit(3);
  process.exit(0);
}

main().catch(err => {
  console.error(`persist_bars failed: ${err.stack || err.message}`);
  process.exit(1);
});
