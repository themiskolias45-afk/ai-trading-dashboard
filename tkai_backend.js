// =====================================================
// TKAI – BACKEND SERVER (TELEGRAM + DASHBOARD API)
// Assets: BTC, GOLD (PAXG)
// Scans: Hourly
// Daily Report: 23:00 London
// =====================================================

const express = require("express");
const fetch = require("node-fetch");
const cron = require("node-cron");

// ================== TELEGRAM ==================

const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

// ================== MARKET APIs ==================

const BTC_API =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

const GOLD_API =
  "https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd";

// ================== APP ==================

const app = express();
const PORT = process.env.PORT || 3000;

let latestData = {
  status: "starting",
  btc: null,
  gold: null,
  updated: null,
};

// ================== TELEGRAM ==================

async function sendTelegram(message) {
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
        }),
      }
    );
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

// ================== MARKET DATA ==================

async function fetchMarket() {
  try {
    const btc = await (await fetch(BTC_API)).json();
    const gold = await (await fetch(GOLD_API)).json();

    latestData = {
      status: "live",
      btc: btc.bitcoin.usd,
      gold: gold["pax-gold"].usd,
      updated: new Date().toISOString(),
    };

    return latestData;
  } catch (err) {
    console.error("Market fetch error:", err.message);
    latestData.status = "error";
    return null;
  }
}

// ================== API ==================

app.get("/", (req, res) => {
  res.send("TKAI Backend is running");
});

app.get("/api/status", async (req, res) => {
  if (!latestData.btc) {
    await fetchMarket();
  }
  res.json(latestData);
});

// ================== CRON ==================

// Hourly scan
cron.schedule("0 * * * *", async () => {
  const data = await fetchMarket();
  if (!data) return;

  await sendTelegram(
    `📊 TKAI Hourly Scan\n\nBTC: $${data.btc}\nGOLD: $${data.gold}`
  );
});

// Daily report – 23:00 London
cron.schedule("0 23 * * *", async () => {
  const data = await fetchMarket();
  if (!data) return;

  await sendTelegram(
    `📈 TKAI Daily Report\n\nBTC: $${data.btc}\nGOLD: $${data.gold}`
  );
});

// ================== START ==================

app.listen(PORT, async () => {
  console.log(`TKAI backend running on port ${PORT}`);

  await sendTelegram(
    "🤖 TKAI started successfully.\n• Hourly scans\n• Daily report 23:00 London"
  );
});