/**
 * BTC TELEGRAM ANALYSIS BOT
 * Telegram ONLY – BTC ONLY
 * Node 18+
 * Polling (NO webhook, NO dashboard)
 */

/* =========================
   TELEGRAM CONFIG (ONCE)
   ========================= */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

/* =========================
   SAFE FETCH (Node 18+)
   ========================= */
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* =========================
   SEND TELEGRAM MESSAGE
   ========================= */
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

/* =========================
   BTC ANALYSIS
   ========================= */
function btcAnalysis() {
  return (
    "📊 <b>BTC ANALYSIS</b>\n\n" +
    "Bias: NEUTRAL\n" +
    "Structure: RANGE\n\n" +
    "Plan:\n" +
    "• Wait for liquidity sweep\n" +
    "• Trade only after confirmation\n\n" +
    "No forced entries."
  );
}

/* =========================
   DAILY REPORT
   ========================= */
function dailyReport() {
  return (
    "🗓 <b>BTC DAILY REPORT</b>\n\n" +
    "Market: Consolidation\n" +
    "Risk Level: Medium\n\n" +
    "Best action:\n" +
    "• Patience\n" +
    "• Protect capital"
  );
}

/* =========================
   HANDLE COMMANDS (FIXED)
   ========================= */
async function handleMessage(message) {
  if (!message.text) return;
  if (String(message.chat.id) !== String(TELEGRAM_CHAT_ID)) return;

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

/* =========================
   TELEGRAM POLLING
   ========================= */
let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`;
    const res = await fetch(url);
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

/* =========================
   START BOT
   ========================= */
(async () => {
  await sendTelegram("✅ Telegram BTC bot is running");
  setInterval(pollTelegram, 3000);
})();