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
async function sendTelegram(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

// ======================
// BTC LIVE ANALYSIS (BINANCE)
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
      change > 0 ? "BULLISH" : change < 0 ? "BEARISH" : "NEUTRAL";

    return (
      "📊 <b>BTC ANALYSIS</b>\n\n" +
      `Price: <b>$${price}</b>\n` +
      `24h Change: <b>${change}%</b>\n` +
      `Bias: <b>${bias}</b>\n\n` +
      "Plan:\n" +
      "• Trade with trend\n" +
      "• Wait for confirmation\n\n" +
      "No financial advice."
    );
  } catch (e) {
    return "⚠️ Failed to fetch BTC data";
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
    "Best action:\n" +
    "• Patience\n" +
    "• No forced trades"
  );
}

// ======================
// HANDLE TELEGRAM COMMANDS
// ======================
async function handleMessage(message) {
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim().toLowerCase();

  if (text === "/start") {
    await sendTelegram(
      chatId,
      "✅ BTC Telegram bot is active.\n\nCommands:\n/btc\n/daily"
    );
    return;
  }

  if (text === "/btc" || text === "btc") {
    const report = await getLiveBTC();
    await sendTelegram(chatId, report);
    return;
  }

  if (text === "/daily") {
    await sendTelegram(chatId, dailyReport());
    return;
  }
}

// ======================
// TELEGRAM POLLING LOOP
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
// START BOT
// ======================
console.log("BTC Telegram bot running...");
setInterval(pollTelegram, 3000);