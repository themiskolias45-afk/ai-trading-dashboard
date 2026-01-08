/**
 * BTC TELEGRAM ANALYSIS BOT
 * BTC ONLY — NO DASHBOARD — NO RENDER
 * Node 18+
 */

const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const CHAT_ID = "7063659034";

const BTC_URL =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=200";

// ---------- TELEGRAM ----------
async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
}

// ===============================
// BTC /btc COMMAND (ADD ONLY)
// ===============================

// Safe fetch (Node 18+)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Send Telegram message (SAFE)
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    })
  });
}

// Simple BTC analysis (spot, safe)
async function analyzeBTC() {
  const res = await fetch(
    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=50"
  );
  const data = await res.json();

  const closes = data.map(c => parseFloat(c[4]));
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];

  let bias = "WAIT";
  let explanation = "Market is ranging with no clear momentum.";

  if (last > prev * 1.002) {
    bias = "LONG";
    explanation =
      "BTC is showing bullish momentum with higher close. Buyers are in control.";
  } else if (last < prev * 0.998) {
    bias = "SHORT";
    explanation =
      "BTC is showing bearish pressure with lower close. Sellers dominate.";
  }

  return { bias, last, explanation };
}

// Listen for /btc command
async function checkTelegramUpdates() {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`
  );
  const data = await res.json();

  if (!data.result.length) return;

  const msg = data.result[data.result.length - 1].message;
  if (!msg || !msg.text) return;

  if (msg.text.toLowerCase() === "/btc") {
    const btc = await analyzeBTC();

    const reply =
`📊 *BTC MARKET ANALYSIS*

Bias: *${btc.bias}*
Price: *${btc.last}*

Explanation:
${btc.explanation}

⚠️ Not financial advice`;

    await sendTelegram(reply);
  }
}

// Poll Telegram every 30s
setInterval(checkTelegramUpdates, 30000);
// ---------- SIMPLE BTC ANALYSIS ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

async function analyzeBTC() {
  const res = await fetch(BTC_URL);
  const data = await res.json();
  const closes = data.map(c => Number(c[4]));
  const price = closes.at(-1);

  const ema50 = ema(closes.slice(-50), 50);
  const ema200 = ema(closes.slice(-200), 200);

  let direction = "WAIT";
  let explanation = "Market is ranging. No professional confirmation.";

  if (ema50 > ema200) {
    direction = "LONG";
    explanation =
      "Bullish structure. EMA50 above EMA200 confirms trend continuation.";
  }

  if (ema50 < ema200) {
    direction = "SHORT";
    explanation =
      "Bearish structure. EMA50 below EMA200 confirms downside pressure.";
  }

  return { price, ema50, ema200, direction, explanation };
}

// ---------- DAILY REPORT ----------
async function sendDailyReport() {
  const r = await analyzeBTC();

  const msg = `
📊 BTC DAILY ANALYSIS

Price: ${r.price.toFixed(2)}
Bias: ${r.direction}

EMA50: ${r.ema50.toFixed(2)}
EMA200: ${r.ema200.toFixed(2)}

🧠 Explanation:
${r.explanation}

⏳ Next step:
Wait for confirmation before entry.
`;

  await sendTelegram(msg);
}

// ---------- DAILY TIMER (23:00 LONDON) ----------
function startDailyScheduler() {
  setInterval(async () => {
    const now = new Date();
    const london = new Date(
      now.toLocaleString("en-US", { timeZone: "Europe/London" })
    );

    if (london.getHours() === 23 && london.getMinutes() === 0) {
      await sendDailyReport();
    }
  }, 60000);
}

// ---------- MANUAL ASK (RUN ON START) ----------
(async () => {
  await sendTelegram("✅ BTC Telegram bot started");
  await sendDailyReport();
  startDailyScheduler();
})();