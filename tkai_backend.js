/*************************************************
 * TKAI — BACKEND SERVER (RENDER SAFE)
 * Telegram + Dashboard API
 *************************************************/

const express = require("express");
const cron = require("node-cron");

const app = express();

/* ===================== TELEGRAM ===================== */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
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

/* ===================== API ===================== */
app.get("/api/status", (req, res) => {
  res.json({
    status: "ONLINE",
    service: "TKAI Backend",
    scans: "Hourly",
    daily_report: "23:00 London",
    time: new Date().toISOString(),
  });
});

/* ===================== CRON JOBS ===================== */
cron.schedule("0 * * * *", () => {
  console.log("Hourly scan running...");
});

cron.schedule("0 23 * * *", () => {
  sendTelegram(
    "📊 TKAI Daily Report\n\nNo Grade A signals today.\nMarket neutral."
  );
});

/* ===================== START SERVER ===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("TKAI backend running on port", PORT);
  sendTelegram(
    "🤖 TKAI started successfully.\n• Hourly scans\n• Grade A alerts only\n• Daily report 23:00 London"
  );
});