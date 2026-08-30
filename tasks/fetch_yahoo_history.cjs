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

async function fetchDailyBars(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
            + `?interval=1d&range=${encodeURIComponent(range)}`;

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

async function main() {
  const symbol = process.argv[2];
  const outPath = process.argv[3];
  const range = process.argv[4] || DEFAULT_RANGE;

  if (!symbol || !outPath) {
    console.error("usage: node fetch_yahoo_history.cjs <symbol> <out.csv> [range]");
    process.exit(1);
  }

  const { bars, droppedForNull } = await fetchDailyBars(symbol, range);

  if (bars.length < MIN_USABLE_BARS) {
    console.error(
      `REFUSED ${symbol}: only ${bars.length} usable daily bars, need ${MIN_USABLE_BARS} ` +
      `(210 are consumed by EMA200 warmup before the first signal counts).`
    );
    process.exit(2);
  }

  writeBarsCsv(outPath, bars);

  const firstDate = new Date(bars[0].time * 1000).toISOString().slice(0, 10);
  const lastDate = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10);
  console.log(
    `${symbol}: ${bars.length} bars ${firstDate}..${lastDate}` +
    (droppedForNull > 0 ? ` (dropped ${droppedForNull} incomplete)` : "")
  );
}

main().catch(err => {
  console.error(`FAILED ${process.argv[2] || "?"}: ${err.message}`);
  process.exit(1);
});
