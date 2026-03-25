/**
 * BTC TELEGRAM ANALYSIS BOT
 * Telegram ONLY – BTC ONLY
 * Node 18+
 * Polling (NO webhook)
 */

import http from "http";

// ======================
// TELEGRAM CONFIG
// ======================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";

// ======================
// SEND TELEGRAM MESSAGE
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
// BTC LIVE ANALYSIS (COINGECKO)
// ======================
async function getLiveBTC() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      }
    );

    if (!res.ok) throw new Error("CoinGecko error");

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
// TELEGRAM POLLING
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
// STATUS DATA FOR API
// ======================
async function getStatusData() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    );
    if (!res.ok) throw new Error("CoinGecko error");
    const d = await res.json();
    const price = d.bitcoin?.usd;
    const change = d.bitcoin?.usd_24h_change;
    return {
      status: "online",
      btc: Number.isFinite(price) ? price.toFixed(2) : "N/A",
      gold: "N/A",
      updated: new Date().toISOString(),
      change_24h: Number.isFinite(change) ? change.toFixed(2) : "N/A"
    };
  } catch {
    return { status: "online", btc: "N/A", gold: "N/A", updated: new Date().toISOString() };
  }
}

// ======================
// HTTP API SERVER
// ======================
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/api/status" && req.method === "GET") {
    const data = await getStatusData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`✅ API server running on port ${PORT}`);
});

// ======================
// START BOT
// ======================
console.log("✅ BTC Telegram bot running...");
setInterval(pollTelegram, 3000);