// ==================================================
// TKAI — BACKEND (TELEGRAM + API FOR DASHBOARD)
// ==================================================

import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 TELEGRAM (ALREADY YOURS — DO NOT CHANGE)
const TELEGRAM_BOT_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

// ================= STATE =================
let LAST_SIGNAL = {
  asset: "NONE",
  direction: "WAIT",
  confidence: 0,
  explanation: "No valid signal yet",
  time: new Date().toISOString()
};

// ================= TELEGRAM =================
async function sendTelegram(message) {
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message
        })
      }
    );
  } catch (e) {
    console.error("Telegram error", e.message);
  }
}

// ================= AI LOGIC (SAFE / DEMO) =================
function runAIScan() {
  const confidence = Math.floor(60 + Math.random() * 40);
  const direction = Math.random() > 0.5 ? "LONG" : "SHORT";

  LAST_SIGNAL = {
    asset: "BTCUSD",
    direction,
    confidence,
    explanation:
      confidence >= 80
        ? "Strong displacement + momentum alignment"
        : "Market inside range, waiting confirmation",
    time: new Date().toISOString()
  };

  if (confidence >= 80) {
    sendTelegram(
      `📊 TKAI ALERT\n\n` +
      `Asset: ${LAST_SIGNAL.asset}\n` +
      `Direction: ${LAST_SIGNAL.direction}\n` +
      `Confidence: ${LAST_SIGNAL.confidence}%\n\n` +
      `${LAST_SIGNAL.explanation}`
    );
  }
}

// ================= CRON =================

// Hourly scan
cron.schedule("0 * * * *", () => {
  runAIScan();
});

// Daily report — 23:00 London
cron.schedule("0 23 * * *", () => {
  sendTelegram(
    `📅 TKAI DAILY REPORT\n\n` +
    `Asset: ${LAST_SIGNAL.asset}\n` +
    `Direction: ${LAST_SIGNAL.direction}\n` +
    `Confidence: ${LAST_SIGNAL.confidence}%\n\n` +
    `${LAST_SIGNAL.explanation}`
  );
});

// ================= API FOR DASHBOARD =================
app.get("/api/status", (req, res) => {
  res.json(LAST_SIGNAL);
});

// ================= START =================
app.listen(PORT, () => {
  console.log("TKAI backend running on port", PORT);
  sendTelegram(
    "🤖 TKAI backend started\n• Hourly scans active\n• Daily report 23:00 London"
  );
});