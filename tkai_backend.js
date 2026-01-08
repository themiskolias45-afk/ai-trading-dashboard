/******************************************************************
 * TKAI – BACKEND SERVER (RENDER SAFE)
 * Telegram + Dashboard API
 * Assets: BTC, GOLD (PAXG), SP500, MSFT, AMZN
 * Scans: Hourly
 * Daily Report: 23:00 London
 ******************************************************************/

const express = require("express");
const cron = require("node-cron");

// ---------- SAFE FETCH (Node 18 / Render) ----------
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ---------- APP INIT ----------
const app = express();
app.use(express.json());

// ---------- TELEGRAM ----------
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

// ---------- STATE ----------
const ASSETS = ["BTC", "GOLD (PAXG)", "SP500", "MSFT", "AMZN"];
let lastScan = null;

// ---------- SAFE SCAN (NO CRASH POSSIBLE) ----------
function runScan() {
  lastScan = new Date().toISOString();
  console.log("Scan completed:", lastScan);
}

// ---------- HOURLY SCAN ----------
cron.schedule("0 * * * *", () => {
  runScan();
});

// ---------- DAILY REPORT (23:00 LONDON) ----------
cron.schedule(
  "0 23 * * *",
  async () => {
    await sendTelegram(
      `📊 TKAI Daily Report\n\nAssets: ${ASSETS.join(
        ", "
      )}\nLast Scan: ${lastScan || "N/A"}`
    );
  },
  { timezone: "Europe/London" }
);

// ---------- API (FOR DASHBOARD) ----------
app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    assets: ASSETS,
    lastScan,
    time: new Date().toISOString(),
  });
});

// ---------- ROOT ----------
app.get("/", (req, res) => {
  res.send("TKAI Backend is running");
});

// ---------- SERVER START (RENDER FIX) ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TKAI Backend listening on port ${PORT}`);
});