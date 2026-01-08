// =====================================================
// TKAI – BACKEND SERVER (TELEGRAM + DASHBOARD API)
// Assets: BTC, GOLD (PAXG)
// Scans: Hourly
// Daily Report: 23:00 London
// =====================================================

import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

// ================== TELEGRAM (FIXED) ==================

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

// ================== TELEGRAM FUNCTION ==================

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

// ================== MARKET DATA ==================

async function fetchMarket() {
  try {
    const btcRes = await fetch(BTC_API);
    const goldRes = await fetch(GOLD_API);

    const btcJson = await btcRes.json();
    const goldJson = await goldRes.json();

    latestData = {
      status: "live",
      btc: btcJson.bitcoin.usd,
      gold: goldJson["pax-gold"].usd,
      updated: new Date().toISOString(),
    };

    return latestData;
  } catch (err) {
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

// ================== CRON JOBS ==================

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
  await sendTelegram(
    "🤖 TKAI started successfully.\n• Hourly scans\n• Grade A alerts only\n• Daily report 23:00 London"
  );

  console.log(`TKAI backend running on port ${PORT}`);
});