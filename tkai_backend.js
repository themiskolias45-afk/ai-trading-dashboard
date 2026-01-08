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
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

// ======================
// BTC ANALYSIS
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

  const text = message.text.trim().toLowerCase();

  if (text === "/start") {
    await sendTelegram("✅ BTC Telegram bot started");
    return;
  }

  if (text === "/btc" || text === "btc") {
    await sendTelegram(btcAnalysis());
    return;
  }

  if (text === "/daily") {
    await sendTelegram(dailyReport());
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
// START BOT
// ======================
(async () => {
  await sendTelegram("✅ Telegram BTC bot is running");
  setInterval(pollTelegram, 3000);
})();