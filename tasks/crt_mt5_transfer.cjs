'use strict';
/**
 * Does the CRT result measured on Yahoo transfer to the instrument we TRADE?
 *
 * Every geometry number in this project was measured on Yahoo bars: GC=F (COMEX
 * gold futures) and ^GSPC (the cash index). The engine trades XAUUSD spot and
 * SP500 CFD. Those are different instruments — GC=F sat ~$58 from XAUUSD the last
 * time both were measured in the same minute — and that basis has already
 * produced one phantom signal here: a Gold BUY at confidence 72 on Yahoo that was
 * confidence 0 on real broker bars.
 *
 * So a walk-forward on GC=F does not license trading XAUUSD. This asks the narrow
 * question that stands between CRT and a decision: over the SAME recent window,
 * does CRT behave the same way on both series?
 *
 * WHY NOT A FULL WALK-FORWARD ON MT5. The bridge caches 300 daily / 400 H4 / 400
 * H1 bars (BAR_COUNT_BY_TIMEFRAME). 300 daily bars yields roughly two dozen CRT
 * patterns — too few to split into folds without the fold size becoming a joke.
 * Raising the bridge's bar count is possible but the candle payload already hit a
 * 413 once at ~240kb, so that is a separate, deliberate change. A transfer test is
 * what this sample can honestly support.
 *
 * READ-ONLY. Pulls bars from the local server, computes, prints. Changes nothing.
 *
 * Usage: node tasks/crt_mt5_transfer.cjs [--hold 20]
 */

const http  = require("http");
const https = require("https");
const path  = require("path");
const { detectCRT } = require(path.join(__dirname, "..", "server", "structure.js"));

const HOLD_BARS = (() => {
  const i = process.argv.indexOf("--hold");
  const v = i !== -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : 20;
})();

// Yahoo proxy for each broker symbol, and the timeframe map.
const PAIRS = [
  { asset: "gold", yahoo: "GC=F",  label: "GOLD" },
  { asset: "spx",  yahoo: "^GSPC", label: "SPX"  },
  { asset: "btc",  yahoo: "BTC-USD", label: "BTC" },
];
const TIMEFRAMES = [
  { key: "d1", yahooInterval: "1d", yahooRange: "2y",   label: "D1" },
  { key: "h1", yahooInterval: "1h", yahooRange: "730d", label: "H1" },
];

function getLocal(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: 3001, path: pathname, timeout: 15000 }, res => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + " " + body.slice(0, 120)));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

function getYahoo(ticker, interval, range) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker)
    + "?range=" + range + "&interval=" + interval;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const q = JSON.parse(body).chart.result[0].indicators.quote[0];
          const rows = q.high.map((h, i) => [h, q.low[i], q.close[i]])
            .filter(r => r.every(v => typeof v === "number" && Number.isFinite(v)));
          resolve({ highs: rows.map(r => r[0]), lows: rows.map(r => r[1]), closes: rows.map(r => r[2]) });
        } catch (e) { reject(new Error("parse " + ticker + ": " + e.message)); }
      });
    }).on("error", reject);
  });
}

/** Keep only the most recent n bars, so both series cover the same window length. */
function tail(bars, n) {
  const from = Math.max(0, bars.highs.length - n);
  return { highs: bars.highs.slice(from), lows: bars.lows.slice(from), closes: bars.closes.slice(from) };
}

function averageBarRange(bars) {
  let total = 0;
  for (let i = 0; i < bars.highs.length; i++) total += bars.highs[i] - bars.lows[i];
  return bars.highs.length ? total / bars.highs.length : 0;
}

function resolveTrade(bars, startIndex, direction, entry, stop, target, holdBars) {
  const risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
  if (!(risk > 0) || !(reward > 0)) return null;
  const isLong = direction === "bullish";
  const limit = Math.min(startIndex + holdBars, bars.highs.length - 1);
  for (let j = startIndex + 1; j <= limit; j++) {
    if (isLong ? bars.lows[j]  <= stop   : bars.highs[j] >= stop)   return { grossR: -1, risk, outcome: "LOSS" };
    if (isLong ? bars.highs[j] >= target : bars.lows[j]  <= target) return { grossR: reward / risk, risk, outcome: "WIN" };
  }
  return { grossR: 0, risk, outcome: "TIMEOUT" };
}

function crtTrades(bars, holdBars) {
  const patterns = detectCRT(bars, { maxPatterns: 1000000 }).patterns;
  const trades = [];
  for (const p of patterns) {
    const t = resolveTrade(bars, p.barIndex, p.direction, bars.closes[p.barIndex],
      p.invalidation, p.objective, holdBars);
    if (t) { t.direction = p.direction; trades.push(t); }
  }
  return trades;
}

function expectancy(trades, costPrice) {
  if (!trades.length) return null;
  let total = 0;
  for (const t of trades) total += t.grossR - ((costPrice || 0) / t.risk);
  return total / trades.length;
}

function breakEven(trades, range) {
  if (!trades.length || expectancy(trades, 0) <= 0) return 0;
  let low = 0, high = range * 2;
  if (expectancy(trades, high) > 0) return high;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (expectancy(trades, mid) > 0) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

function summary(trades, range) {
  if (!trades.length) return null;
  const decided = trades.filter(t => t.outcome !== "TIMEOUT").length;
  const wins = trades.filter(t => t.outcome === "WIN").length;
  return {
    n: trades.length,
    winRate: decided ? (wins / decided) * 100 : null,
    gross: expectancy(trades, 0),
    breakEven: breakEven(trades, range),
    breakEvenPct: range > 0 ? (breakEven(trades, range) / range) * 100 : null,
    bullish: trades.filter(t => t.direction === "bullish").length,
  };
}

function line(tag, s, range) {
  if (!s) return "    " + tag.padEnd(18) + "no patterns";
  return "    " + tag.padEnd(18)
    + String(s.n).padStart(4) + " trades"
    + (s.winRate == null ? "     n/a" : ("  " + s.winRate.toFixed(0) + "% win").padStart(10))
    + ("  " + (s.gross >= 0 ? "+" : "") + s.gross.toFixed(3) + "R").padStart(12)
    + "   break-even " + s.breakEven.toFixed(2) + " (" + (s.breakEvenPct == null ? "?" : s.breakEvenPct.toFixed(1)) + "% of range)"
    + "   avg bar range " + range.toFixed(2);
}

(async () => {
  console.log("CRT TRANSFER TEST — Yahoo proxy vs the instrument the engine trades");
  console.log("Same recent window, same detector, same trade construction, " + HOLD_BARS + "-bar hold.");
  console.log("The question is not 'is CRT good' — it is 'does the Yahoo result describe XAUUSD'.\n");

  let raw;
  try {
    raw = await getLocal("/api/mt5/candles/raw");
  } catch (e) {
    console.error("Could not read MT5 bars from the local server: " + e.message);
    console.error("This must run on the machine hosting the server (requireLocalOnly), "
      + "and the bridge must have pushed candles since the last restart.");
    process.exit(1);
  }

  for (const pair of PAIRS) {
    const entry = raw.assets ? raw.assets[pair.asset] : null;
    if (!entry) { console.log(pair.label + ": no MT5 bars cached\n"); continue; }

    console.log("═".repeat(96));
    console.log(pair.label + "   broker " + entry.symbol + "   vs Yahoo " + pair.yahoo
      + "   (bars pushed " + Math.round(entry.ageMs / 1000) + "s ago)");
    console.log("═".repeat(96));

    for (const tf of TIMEFRAMES) {
      const brokerBars = entry.bars[tf.key];
      if (!brokerBars || !brokerBars.closes || brokerBars.closes.length < 60) {
        console.log("  " + tf.label + ": too few broker bars"); continue;
      }
      let yahooFull;
      try { yahooFull = await getYahoo(pair.yahoo, tf.yahooInterval, tf.yahooRange); }
      catch (e) { console.log("  " + tf.label + ": Yahoo fetch failed — " + e.message); continue; }

      // Same window LENGTH on both, ending now, so the comparison is like for like.
      const n = Math.min(brokerBars.closes.length, yahooFull.closes.length);
      const broker = tail(brokerBars, n);
      const yahoo  = tail(yahooFull, n);

      const brokerRange = averageBarRange(broker);
      const yahooRange  = averageBarRange(yahoo);
      const brokerSummary = summary(crtTrades(broker, HOLD_BARS), brokerRange);
      const yahooSummary  = summary(crtTrades(yahoo,  HOLD_BARS), yahooRange);

      console.log("  " + tf.label + "  (" + n + " bars each)");
      console.log(line("broker " + entry.symbol, brokerSummary, brokerRange));
      console.log(line("yahoo " + pair.yahoo,    yahooSummary,  yahooRange));

      if (brokerSummary && yahooSummary) {
        const grossGap = brokerSummary.gross - yahooSummary.gross;
        const countGap = brokerSummary.n - yahooSummary.n;
        const sameSign = (brokerSummary.gross > 0) === (yahooSummary.gross > 0);
        // Which side is positive matters more than whether they agree. An
        // "opposite sign" where the BROKER is the profitable one is the
        // favourable case, and calling that a failure would be exactly backwards
        // — the broker series is the one we actually trade.
        let verdict;
        if (!sameSign) {
          verdict = brokerSummary.gross > 0
            ? "PROXY UNDERSTATED IT — broker positive, Yahoo negative"
            : "DOES NOT TRANSFER — Yahoo positive but the TRADED instrument is negative";
        } else if (Math.abs(grossGap) < 0.05) {
          verdict = "TRANSFERS — same sign, gap inside noise";
        } else {
          verdict = (grossGap < 0 ? "PROXY OVERSTATED IT — " : "PROXY UNDERSTATED IT — ")
            + "same sign, " + (grossGap >= 0 ? "+" : "") + grossGap.toFixed(3) + "R apart";
        }
        console.log("    verdict: " + verdict
          + "   (pattern count " + (countGap >= 0 ? "+" : "") + countGap + " on broker)");
      }
    }
    console.log("");
  }

  console.log("Sample here is one to two years, not ten, and is not folded — the bridge caches");
  console.log("300 daily bars. Treat this as a transfer check on the walk-forward, not a");
  console.log("replacement for it. Nothing here changes a live setting.");
  console.log("");
  console.log("Two limits worth holding in mind. The windows are matched by BAR COUNT, not by");
  console.log("calendar: XAUUSD spot and GC=F futures keep different hours, so 300 bars of each");
  console.log("do not span exactly the same days. And a large gap in PATTERN COUNT between the");
  console.log("two series is itself the finding — it means the detector is seeing different");
  console.log("structure on the two instruments, which is what a basis does.");
})().catch(e => { console.error("FAILED: " + e.message); process.exit(1); });
