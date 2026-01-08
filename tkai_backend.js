/*************************************************
 * TKAI — BACKEND SERVER (RENDER SAFE)
 * Telegram + Dashboard API
 * Assets: BTC, GOLD (PAXG), SP500, MSFT, AMZN
 * Scans: Hourly
 * Daily Report: 23:00 London
 *************************************************/

const express = require("express");
const cron = require("node-cron");

/* ================================
   SAFE FETCH (Node 18 + Render)
================================ */
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* ================================
   APP INIT
================================ */
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ================================
   TELEGRAM CONFIG
================================ */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

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

/* ================================
   ASSETS CONFIG
================================ */
const ASSETS = [
  { key: "BTC", name: "Bitcoin", symbol: "BTCUSDT" },
  { key: "GOLD", name: "Gold (PAXG)", symbol: "PAXGUSDT" },
  { key: "SP500", name: "S&P 500", symbol: "^GSPC" },
  { key: "MSFT", name: "Microsoft", symbol: "MSFT" },
  { key: "AMZN", name: "Amazon", symbol: "AMZN" },
];

/* ================================
   MARKET DATA (SAFE DEMO)
   (You can replace with real APIs later)
================================ */
function generateMockSignal(asset) {
  const directions = ["BULLISH", "BEARISH"];
  const direction = directions[Math.floor(Math.random() * 2)];

  return {
    asset: asset.name,
    direction,
    bias: direction === "BULLISH" ? "LONG" : "SHORT",
    confidence: Math.floor(65 + Math.random() * 20),
    explanation:
      direction === "BULLISH"
        ? "Higher highs, momentum strengthening, buyers in control."
        : "Lower highs, rejection at resistance, sellers dominant.",
    time: new Date().toISOString(),
  };
}

/* ================================
   GLOBAL STATE (Dashboard)
================================ */
let latestSignals = [];
let lastScanTime = null;

/* ================================
   HOURLY SCAN
================================ */
async function runHourlyScan() {
  console.log("Running hourly scan...");
  lastScanTime = new Date().toISOString();
  latestSignals = ASSETS.map(generateMockSignal);

  for (const s of latestSignals) {
    await sendTelegram(
      `📊 ${s.asset}\n` +
        `Bias: ${s.bias}\n` +
        `Direction: ${s.direction}\n` +
        `Confidence: ${s.confidence}%\n\n` +
        `🧠 ${s.explanation}`
    );
  }
}

/* ================================
   DAILY REPORT (23:00 LONDON)
================================ */
async function sendDailyReport() {
  let report = "📘 TKAI Daily Market Summary\n\n";

  for (const s of latestSignals) {
    report +=
      `• ${s.asset}\n` +
      `  Bias: ${s.bias}\n` +
      `  Confidence: ${s.confidence}%\n\n`;
  }

  await sendTelegram(report || "No data available today.");
}

/* ================================
   CRON JOBS
================================ */
cron.schedule("0 * * * *", runHourlyScan); // every hour
cron.schedule("0 23 * * *", sendDailyReport, {
  timezone: "Europe/London",
});

/* ================================
   API ROUTES (DASHBOARD)
================================ */
app.get("/api/status", (req, res) => {
  res.json({
    status: "ONLINE",
    service: "TKAI Backend",
    lastScanTime,
    signals: latestSignals,
  });
});

/* ================================
   START SERVER
================================ */
app.listen(PORT, async () => {
  console.log(`TKAI backend running on port ${PORT}`);
  await sendTelegram("🤖 TKAI started successfully.\n• Hourly scans active\n• Daily report 23:00 London");
});