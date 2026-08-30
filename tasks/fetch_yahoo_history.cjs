// Fetches daily bars from Yahoo and writes them in the EXACT CSV shape
// tasks/_replay_engine.cjs expects: time,open,high,low,close,tick_volume with
// `time` in unix SECONDS.
//
//   node tasks/fetch_yahoo_history.cjs AAPL tasks/history_yahoo/AAPL_D1.csv [range]
//
// Why a separate fetcher rather than reusing server/index.js: requiring index.js
// boots express, the cron jobs and the MT5 polling loop. _replay_engine.cjs solves
// the same problem by extracting functions from the source; this file only needs one
// HTTP call, so it makes it directly.
//
// BARS ARE DROPPED, NOT PATCHED, when Yahoo returns a null in any OHLC slot. Yahoo
// emits nulls for halted or untraded sessions, and carrying the previous close
// forward invents a doji that never happened — on a 200-bar EMA that is a silent
// distortion of exactly the indicator the engine leans on hardest. A gap is honest;
// a fabricated bar is not.

const fs = require("fs");
const path = require("path");

const DEFAULT_RANGE = "10y";
// _replay_engine.cjs skips its first 210 bars (EMA200 warmup) before any signal is
// considered meaningful, then needs room to actually trade. A series shorter than
// this cannot produce a measurement worth ranking, so it is refused loudly rather
// than quietly contributing a two-trade sample to a league table.
const MIN_USABLE_BARS = 400;

async function fetchDailyBars(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
            + `?interval=${encodeURIComponent(interval || "1d")}&range=${encodeURIComponent(range)}`;

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (SmartEntry instrument scan)" },
  });

  if (!response.ok) {
    throw new Error(`Yahoo returned HTTP ${response.status} for ${symbol}`);
  }

  const body = await response.json();
  const result = body?.chart?.result?.[0];
  if (!result) {
    const message = body?.chart?.error?.description || "no result block";
    throw new Error(`Yahoo gave no series for ${symbol}: ${message}`);
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!Array.isArray(timestamps) || !quote) {
    throw new Error(`Yahoo series for ${symbol} has no timestamp/quote arrays`);
  }

  const bars = [];
  let droppedForNull = 0;

  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i];
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i];

    const everyPriceIsReal =
      Number.isFinite(time) &&
      Number.isFinite(open) && Number.isFinite(high) &&
      Number.isFinite(low) && Number.isFinite(close);

    if (!everyPriceIsReal) { droppedForNull++; continue; }

    // A bar whose high is below its low, or whose close sits outside the range, is
    // corrupt rather than merely odd. Dropping it is cheaper than reasoning about
    // what a negative "risk" does inside the replay's stop/target walk.
    if (high < low || close > high || close < low || open > high || open < low) {
      droppedForNull++;
      continue;
    }

    bars.push({
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? Math.round(volume) : 0,
    });
  }

  return { bars, droppedForNull };
}

function writeBarsCsv(outPath, bars) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const lines = ["time,open,high,low,close,tick_volume"];
  for (const bar of bars) {
    lines.push(
      `${bar.time},${bar.open.toFixed(5)},${bar.high.toFixed(5)},` +
      `${bar.low.toFixed(5)},${bar.close.toFixed(5)},${bar.volume}`
    );
  }
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}

// Aggregates finer bars into `hours`-wide buckets, aligned to the UTC day.
//
// FOR A RELATIVE COMPARISON ONLY. A broker's NAS100 CFD trades ~23h a day, so its H4
// candles are not these. Yahoo's hourly equity series covers the cash session, so
// resampling it produces 4h buckets over a 6.5h day -- fewer bars per day, and boundaries
// that do not line up with the broker's. Two instruments resampled the SAME way are still
// comparable to each other, which is the question; neither is comparable to a broker feed.
function resampleBars(bars, hours) {
  const width = hours * 3600;
  const buckets = new Map();
  for (const bar of bars) {
    const key = Math.floor(bar.time / width) * width;
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { time: key, open: bar.open, high: bar.high, low: bar.low,
                         close: bar.close, volume: bar.volume });
      continue;
    }
    // Open is the FIRST bar's open and close the LAST bar's close, so the bucket
    // describes the period rather than any single bar inside it.
    bucket.high = Math.max(bucket.high, bar.high);
    bucket.low = Math.min(bucket.low, bar.low);
    bucket.close = bar.close;
    bucket.volume += bar.volume;
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function main() {
  const symbol = process.argv[2];
  const outPath = process.argv[3];
  const range = process.argv[4] || DEFAULT_RANGE;
  const interval = process.argv[5] || "1d";
  // --resample <hours> aggregates the fetched series before writing. Used to build an
  // H4 series, which Yahoo does not offer natively.
  const resampleIdx = process.argv.indexOf("--resample");
  const resampleHours = resampleIdx > -1 ? Number(process.argv[resampleIdx + 1]) : null;

  if (!symbol || !outPath) {
    console.error("usage: node fetch_yahoo_history.cjs <symbol> <out.csv> [range] [interval] [--resample <hours>]");
    process.exit(1);
  }
  if (resampleIdx > -1 && (!Number.isFinite(resampleHours) || resampleHours <= 0)) {
    console.error(`--resample needs a positive number of hours, got "${process.argv[resampleIdx + 1]}"`);
    process.exit(1);
  }

  const fetched = await fetchDailyBars(symbol, range, interval);
  const droppedForNull = fetched.droppedForNull;
  const bars = resampleHours ? resampleBars(fetched.bars, resampleHours) : fetched.bars;

  // The 400-bar floor is a DAILY-series rule: 210 of them go to EMA200 warmup before a
  // signal counts. An intraday or resampled series is governed by the consuming harness
  // instead (_replay_mtf.cjs wants H4>=300, H1>=100), so it is not held to that floor.
  const floor = (interval === "1d" && !resampleHours) ? MIN_USABLE_BARS : 1;

  if (bars.length < floor) {
    console.error(
      `REFUSED ${symbol}: only ${bars.length} usable bars, need ${floor} ` +
      `(210 are consumed by EMA200 warmup before the first signal counts).`
    );
    process.exit(2);
  }

  writeBarsCsv(outPath, bars);

  const firstDate = new Date(bars[0].time * 1000).toISOString().slice(0, 10);
  const lastDate = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10);
  console.log(
    `${symbol}: ${bars.length} bars ${firstDate}..${lastDate}` +
    (resampleHours ? ` [resampled to ${resampleHours}h from ${fetched.bars.length}]` : "") +
    (droppedForNull > 0 ? ` (dropped ${droppedForNull} incomplete)` : "")
  );
}

main().catch(err => {
  console.error(`FAILED ${process.argv[2] || "?"}: ${err.message}`);
  process.exit(1);
});
