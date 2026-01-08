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