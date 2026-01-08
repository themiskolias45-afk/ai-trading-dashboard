/**
 * BTC TELEGRAM ANALYSIS BOT
 * Telegram ONLY – BTC ONLY
 * Node 18+
 * Polling (NO webhook, NO dashboard)
 */

// ======================
// TELEGRAM TOKEN (ONLY)
// ======================
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";

// ======================
// SAFE FETCH (Node 18+)
// ======================
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ======================
// SAFE FETCH (Node 18+)
// ======================
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));


// ======================
// BINANCE BTC LIVE DATA   ✅ ADD HERE
// ======================
async function fetchBTC() {
  ...
}


// ======================
// SEND TELEGRAM MESSAGE  ⬇️ MUST BE BELOW
// ======================
async function sendTelegram(text) {
  ...
}
// ======================
// SEND TELEGRAM MESSAGE
// ======================
async function sendTelegram(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

// ======================
// BTC ANALYSIS (STATIC BASE)
// ======================
function btcAnalysis() {
  return (
    "📊 <b>BTC ANALYSIS</b>\n\n" +
    "Bias: NEUTRAL\n" +
    "Market: RANGE\n\n" +
    "Plan:\n" +
    "• Wait for breakout\n" +
    "• No confirmed entry\n\n" +
    "Next step: live logic"
  );
}

// ======================
// LIVE BTC PRICE (BINANCE)
// ======================
async function getLiveBTC() {
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"
    );
    const d = await res.json();

    const price = Number(d.lastPrice).toFixed(2);
    const change = Number(d.priceChangePercent).toFixed(2);

    const bias =
      change > 0 ? "BULLISH" :
      change < 0 ? "BEARISH" :
      "NEUTRAL";

    return (
      "📊 <b>BTC LIVE PRICE</b>\n\n" +
      `Price: <b>$${price}</b>\n` +
      `24h Change: <b>${change}%</b>\n\n` +
      `Bias: <b>${bias}</b>\n\n` +
      "Plan:\n" +
      "• Trade with trend\n" +
      "• Wait for confirmation"
    );
  } catch (e) {
    return "⚠️ Failed to fetch BTC price";
  }
}

// ======================
// DAILY REPORT
// ======================
function dailyReport() {
  return (
    "🗓 <b>BTC DAILY REPORT</b>\n\n" +
    "Market: Consolidation\n" +
    "Risk: Medium\n\n" +
    "Best action: Patience"
  );
}

// ======================
// HANDLE MESSAGE (FIXED)
// ======================
async function handleMessage(message) {
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim().toLowerCase();

  if (text === "/start") {
    await sendTelegram(chatId, "✅ BTC Telegram bot started");
    return;
  }

  if (text === "/btc" || text === "btc") {
    const live = await getLiveBTC();
    await sendTelegram(chatId, live);
    return;
  }

  if (text === "/daily") {
    await sendTelegram(chatId, dailyReport());
    return;
  }
}

// ======================
// POLLING LOOP
// ======================
let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`
    );
    const data = await res.json();

    if (!data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      if (update.message) {
        await handleMessage(update.message);
      }
    }
  } catch (e) {
    console.error("Polling error:", e.message);
  }
}

// ======================
// DAILY SCHEDULER (23:00 LONDON)
// ======================
function startDailyReport() {
  setInterval(async () => {
    const now = new Date();

    // Convert to London time
    const london = new Date(
      now.toLocaleString("en-US", { timeZone: "Europe/London" })
    );

    const hours = london.getHours();
    const minutes = london.getMinutes();

    // Send once at 23:00
    if (hours === 23 && minutes === 0) {
      const report = await getLiveBTC();
      await sendTelegram(
        "📅 <b>DAILY BTC REPORT</b>\n\n" + report
      );

      // prevent duplicate sends in same minute
      await new Promise(r => setTimeout(r, 61000));
    }
  }, 30000);
}
// ======================
// START BOT
// ======================
console.log("BTC Telegram bot running...");
setInterval(pollTelegram, 3000);
startDailyReport();