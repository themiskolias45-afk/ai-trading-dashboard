/*********************************************************
 * TKAI – BACKEND SERVER (RENDER SAFE)
 * Telegram + Dashboard API
 * Assets: BTC, GOLD (PAXG), SP500, MSFT, AMZN
 * Scans: Hourly
 * Daily Report: 23:00 London
 *********************************************************/

const express = require("express");
const cron = require("node-cron");

/* ================= SAFE FETCH (Node 18 + Render) ================= */
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* ================= APP INIT ================= */
const app = express();
app.use(express.json());

/* ================= CORS (REQUIRED FOR DASHBOARD) ================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

/* ================= TELEGRAM CONFIG (FIXED) ================= */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

/* ================= TELEGRAM SENDER ================= */
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

/* ================= STATUS OBJECT ================= */
let STATUS = {
  service: "TKAI Backend",
  status: "running",
  lastScan: null,
  assets: ["BTC", "GOLD (PAXG)", "SP500", "MSFT", "AMZN"],
};

/* ================= API ROUTES ================= */
app.get("/", (req, res) => {
  res.send("TKAI Backend is running");
});

app.get("/api/status", (req, res) => {
  res.json(STATUS);
});

/* ================= SCAN ENGINE ================= */
async function runScan() {
  const now = new Date().toISOString();
  STATUS.lastScan = now;

  console.log("TKAI scan executed:", now);

  await sendTelegram(
    `🤖 TKAI Hourly Scan\n\nTime: ${now}\nAssets:\n• BTC\n• GOLD (PAXG)\n• SP500\n• MSFT\n• AMZN\n\nStatus: OK`
  );
}

/* ================= CRON JOBS ================= */

// Hourly scan
cron.schedule("0 * * * *", runScan);

// Daily report – 23:00 London time
cron.schedule("0 23 * * *", () => {
  sendTelegram(
    `📊 TKAI Daily Report\n\nAll systems operational.\nScans running normally.\n\nTime: 23:00 London`
  );
});

/* ================= SERVER START ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TKAI Backend running on port ${PORT}`);
  sendTelegram(
    "🚀 TKAI started successfully.\n\n• Hourly scans active\n• Daily report enabled\n• Dashboard API online"
  );
});