// ===============================
// TKAI — BACKEND AI BOT
// ===============================

import fetch from "node-fetch";
import fs from "fs";
import cron from "node-cron";

// ===============================
// TELEGRAM CONFIG (READY)
// ===============================
const TELEGRAM_BOT_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

// ===============================
// ASSETS
// ===============================
const ASSETS = {
  BTC: {
    label: "BTCUSD",
    base: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT",
  },
  GOLD: {
    label: "GOLD (PAXG)",
    base: "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT",
  },
  SP500: {
    label: "SP500 (SPY)",
    base: "https://query1.finance.yahoo.com/v8/finance/chart/SPY",
    yahoo: true,
  },
  MSFT: {
    label: "MSFT",
    base: "https://query1.finance.yahoo.com/v8/finance/chart/MSFT",
    yahoo: true,
  },
  AMZN: {
    label: "AMZN",
    base: "https://query1.finance.yahoo.com/v8/finance/chart/AMZN",
    yahoo: true,
  },
};

// ===============================
// HELPERS
// ===============================
const parseBinance = (d) =>
  d.map((c) => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
  }));

const parseYahoo = (d) => {
  const q = d.chart.result[0];
  return q.indicators.quote[0].close.map((c, i) => ({
    open: q.indicators.quote[0].open[i],
    high: q.indicators.quote[0].high[i],
    low: q.indicators.quote[0].low[i],
    close: c,
  }));
};

const bias = (c) => {
  if (!c || c.length < 20) return "RANGE";
  const hh = c.at(-1).high > c.at(-5).high;
  const hl = c.at(-1).low > c.at(-5).low;
  const lh = c.at(-1).high < c.at(-5).high;
  const ll = c.at(-1).low < c.at(-5).low;
  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "RANGE";
};

const displacement = (c) => {
  const a = c.at(-1);
  const b = c.at(-2);
  return Math.abs(a.close - a.open) > (b.high - b.low) * 1.5;
};

const levels = (p, dir) => {
  const r = p * 0.006;
  return dir === "BULLISH"
    ? { entry: p, sl: p - r, tp1: p + r, tp2: p + r * 2 }
    : { entry: p, sl: p + r, tp1: p - r, tp2: p - r * 2 };
};

// ===============================
// TELEGRAM
// ===============================
async function sendTG(msg) {
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg }),
    }
  );
}

// ===============================
// CORE SCAN
// ===============================
async function scanAsset(key, a) {
  try {
    let data;
    if (a.yahoo) {
      const r = await fetch(a.base + "?range=5d&interval=15m");
      const j = await r.json();
      data = parseYahoo(j);
    } else {
      const r = await fetch(a.base + "&interval=15m&limit=120");
      const j = await r.json();
      data = parseBinance(j);
    }

    const b = bias(data);
    const disp = displacement(data);
    const price = data.at(-1).close;
    const lv = levels(price, b);
    const ok = disp && b !== "RANGE";
    const confidence = ok ? "A" : "C";

    const explanation = ok
      ? "Institutional displacement detected. Continuation likely."
      : "Market in equilibrium or pullback. Waiting.";

    // Save CSV
    const line = `${new Date().toISOString()},${a.label},${price},${b},${confidence}\n`;
    fs.appendFileSync("tkai_history.csv", line);

    if (ok) {
      await sendTG(
`🚨 TKAI — TRADE SIGNAL

Asset: ${a.label}
Bias: ${b}
Action: ${b === "BULLISH" ? "LONG" : "SHORT"}

Entry: ${lv.entry.toFixed(2)}
TP1: ${lv.tp1.toFixed(2)}
TP2: ${lv.tp2.toFixed(2)}
SL: ${lv.sl.toFixed(2)}

Confidence: A
Explanation:
${explanation}`
      );
    }
  } catch (e) {
    console.error("Error scanning", key, e.message);
  }
}

// ===============================
// HOURLY SCAN
// ===============================
cron.schedule("0 * * * *", async () => {
  for (const [k, a] of Object.entries(ASSETS)) {
    await scanAsset(k, a);
  }
});

// ===============================
// DAILY REPORT — 23:00 LONDON
// ===============================
cron.schedule("0 23 * * *", async () => {
  let msg = "🤖 TKAI — DAILY MARKET PLAN (23:00 London)\n\n";
  for (const a of Object.values(ASSETS)) {
    msg += `${a.label}: Monitoring for displacement.\n`;
  }
  await sendTG(msg);
}, { timezone: "Europe/London" });

// ===============================
// START
// ===============================
(async () => {
  await sendTG("🤖 TKAI started successfully. Monitoring markets 24/7.");
})();