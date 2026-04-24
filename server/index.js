/**
 * SmartEntry Server v7
 * Express API + Telegram Bot (polling)
 * Port: 3001
 */

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";

// ── Price cache ──────────────────────────────────────────────
let priceCache = { btc: null, gold: null, updated: null };

async function fetchPrices() {
  try {
    const [btcRes, goldRes] = await Promise.allSettled([
      axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        { timeout: 8000, headers: { "User-Agent": "SmartEntry/7.0" } }
      ),
      axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=gold&vs_currencies=usd",
        { timeout: 8000, headers: { "User-Agent": "SmartEntry/7.0" } }
      )
    ]);

    const btc = btcRes.status === "fulfilled"
      ? btcRes.value.data?.bitcoin?.usd ?? null
      : priceCache.btc;

    const btcChange = btcRes.status === "fulfilled"
      ? btcRes.value.data?.bitcoin?.usd_24h_change ?? 0
      : 0;

    // Gold via metals-api fallback — CoinGecko doesn't carry gold reliably
    let gold = priceCache.gold;
    if (goldRes.status === "fulfilled" && goldRes.value.data?.gold?.usd) {
      gold = goldRes.value.data.gold.usd;
    }

    priceCache = {
      btc: btc != null ? parseFloat(btc.toFixed(2)) : priceCache.btc,
      btcChange: parseFloat((btcChange || 0).toFixed(2)),
      gold: gold != null ? parseFloat(gold.toFixed(2)) : priceCache.gold,
      updated: new Date().toISOString()
    };
  } catch (err) {
    console.error("fetchPrices error:", err.message);
  }
}

// ── API endpoints ────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    btc: priceCache.btc,
    btcChange: priceCache.btcChange,
    gold: priceCache.gold,
    updated: priceCache.updated
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: 7, ts: Date.now() });
});

// ── Telegram helpers ─────────────────────────────────────────
async function sendTelegram(chatId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true },
      { timeout: 5000 }
    );
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

function buildBtcReport() {
  const { btc, btcChange } = priceCache;
  if (!btc) return "⚠️ BTC data unavailable.";

  const bias =
    btcChange > 2  ? "STRONG BULLISH" :
    btcChange > 0  ? "BULLISH" :
    btcChange < -2 ? "STRONG BEARISH" :
    btcChange < 0  ? "BEARISH" : "NEUTRAL";

  return (
    "📊 <b>BTC ANALYSIS</b>\n\n" +
    `Price: <b>$${btc.toLocaleString()}</b>\n` +
    `24h Change: <b>${btcChange > 0 ? "+" : ""}${btcChange}%</b>\n\n` +
    `Bias: <b>${bias}</b>\n\n` +
    "Plan:\n• Trade with trend\n• Wait for confirmation"
  );
}

function buildDailyReport() {
  const { btc, gold } = priceCache;
  return (
    "🗓 <b>DAILY REPORT</b>\n\n" +
    `BTC: <b>${btc ? "$" + btc.toLocaleString() : "N/A"}</b>\n` +
    `Gold: <b>${gold ? "$" + gold.toLocaleString() : "N/A"}</b>\n\n` +
    "Market: Consolidation\nRisk: Medium\n\n" +
    "Best action:\n• Patience\n• No forced trades"
  );
}

async function handleMessage(message) {
  if (!message?.text) return;
  const chatId = message.chat.id;
  const text = message.text.trim().toLowerCase();

  if (text === "/start") {
    await sendTelegram(chatId, "✅ SmartEntry v7 active\n\nCommands:\n/btc — live BTC analysis\n/gold — gold price\n/daily — daily report");
  } else if (text === "/btc" || text === "btc") {
    await fetchPrices();
    await sendTelegram(chatId, buildBtcReport());
  } else if (text === "/gold") {
    await fetchPrices();
    const { gold } = priceCache;
    await sendTelegram(chatId, gold ? `🪙 Gold: <b>$${gold.toLocaleString()}</b>` : "⚠️ Gold data unavailable.");
  } else if (text === "/daily") {
    await sendTelegram(chatId, buildDailyReport());
  }
}

// ── Telegram polling ─────────────────────────────────────────
let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      { timeout: 15000 }
    );
    const updates = res.data?.result ?? [];
    for (const update of updates) {
      lastUpdateId = update.update_id;
      if (update.message) await handleMessage(update.message);
    }
  } catch (e) {
    console.error("Polling error:", e.message);
  }
}

// ── Boot ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ SmartEntry v7 running on port ${PORT}`);
  fetchPrices();
  setInterval(fetchPrices, 60_000);
  setInterval(pollTelegram, 3000);
});
