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
// SAFE FETCH
// ======================
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ======================
// SEND TELEGRAM MESSAGE (FIXED)
// ======================
async function sendTelegram(chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
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
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      }
    );

    if (!res.ok) {
      throw new Error("CoinGecko error");
    }

    const d = await res.json();

    const price = d.bitcoin?.usd;
    const change = d.bitcoin?.usd_24h_change;

    if (!Number.isFinite(price) || !Number.isFinite(change)) {
      return "⚠️ BTC data unavailable.";
    }

    const bias =
      change > 0 ? "BULLISH" :
      change < 0 ? "BEARISH" :
      "NEUTRAL";

    return (
      "📊 <b>BTC ANALYSIS</b>\n\n" +
      `Price: <b>$${price.toFixed(2)}</b>\n` +
      `24h Change: <b>${change.toFixed(2)}%</b>\n\n` +
      `Bias: <b>${bias}</b>\n\n` +
      "Plan:\n" +
      "• Trade with trend\n" +
      "• Wait for confirmation"
    );
  } catch {
    return "⚠️ Failed to fetch BTC data.";
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
// HANDLE COMMANDS
// ======================
async function handleMessage(message) {
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim().toLowerCase();

  if (text === "/start") {
    await sendTelegram(
      chatId,
      "✅ BTC bot active\n\nCommands:\n/btc\n/daily"
    );
  }

  if (text === "/btc" || text === "btc") {
    const report = await getLiveBTC();
    await sendTelegram(chatId, report);
  }

  if (text === "/daily") {
    await sendTelegram(chatId, dailyReport());
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
      if (update.message) await handleMessage(update.message);
    }
  } catch (e) {
    console.error("Polling error:", e.message);
  }
}

// ======================
// START
// ======================
console.log("✅ BTC Telegram bot running...");
setInterval(pollTelegram, 3000);