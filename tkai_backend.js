/**
 * BTC TELEGRAM ANALYSIS BOT
 * Telegram ONLY – BTC ONLY
 * Node 18+
 * Polling (NO webhook, NO dashboard)
 */

// ======================
// TELEGRAM CONFIG (ONCE)
// ======================
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

// ======================
// SAFE FETCH (Node 18+)
// ======================
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ======================
// SEND TELEGRAM MESSAGE
// ======================
async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

// ======================
// GET BTC CANDLES (1H)
// ======================
async function getBTCCandles() {
  const res = await fetch(
    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=60"
  );
  return res.json();
}

// ======================
// EMA CALCULATION
// ======================
function ema(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// ======================
// BTC ANALYSIS (BIAS LOGIC)
// ======================
async function btcAnalysis() {
  const candles = await getBTCCandles();
  const closes = candles.map(c => Number(c[4]));
  const price = closes[closes.length - 1];

  const ema50 = ema(closes.slice(-50), 50);
  const ema200 = ema(closes.slice(-200), 200);

  let bias = "WAIT";
  let explanation =
    "BTC is trading inside equilibrium. No confirmed trend yet.";

  if (ema50 > ema200 * 1.002) {
    bias = "LONG";
    explanation =
      "Bullish structure detected. EMA50 is above EMA200, confirming upward trend strength. Buyers control momentum.";
  } else if (ema50 < ema200 * 0.998) {
    bias = "SHORT";
    explanation =
      "Bearish structure detected. EMA50 is below EMA200, confirming downside pressure. Sellers dominate price action.";
  }

  return { price, ema50, ema200, bias, explanation };
}

// ======================
// DAILY REPORT (ON DEMAND)
// ======================
async function dailyReport() {
  const r = await btcAnalysis();

  return (
    "🗓 <b>BTC DAILY SNAPSHOT</b>\n\n" +
    `Price: <b>$${r.price.toFixed(2)}</b>\n` +
    `Bias: <b>${r.bias}</b>\n\n` +
    "🧠 Explanation:\n" +
    r.explanation
  );
}

// ======================
// HANDLE COMMANDS
// ======================
async function handleMessage(text) {
  const msg = text.toLowerCase();

  if (msg === "/start") {
    await sendTelegram("✅ BTC Telegram bot started");
  }

  if (msg === "/btc" || msg === "btc") {
    const r = await btcAnalysis();

    const message =
      "📊 <b>BTC MARKET ANALYSIS</b>\n\n" +
      `Price: <b>$${r.price.toFixed(2)}</b>\n` +
      `Bias: <b>${r.bias}</b>\n\n` +
      "🧠 Explanation:\n" +
      r.explanation;

    await sendTelegram(message);
  }

  if (msg === "/daily") {
    const report = await dailyReport();
    await sendTelegram(report);
  }
}

// ======================
// TELEGRAM POLLING
// ======================
let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      if (update.message && update.message.text) {
        await handleMessage(update.message.text);
      }
    }
  } catch (e) {
    console.error("Polling error:", e.message);
  }
}

// ======================
// START BOT (SILENT)
// ======================
setInterval(pollTelegram, 3000);