/************************************************
 * TKAI – BACKEND SERVER (STABLE BASE)
 * Dashboard API + Telegram Ready
 ************************************************/

const express = require("express");
const app = express();

/* ================== TELEGRAM ================== */
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
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

/* ================== API ================== */
app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    assets: ["BTC", "GOLD (PAXG)", "SP500", "MSFT", "AMZN"],
    time: new Date().toISOString(),
  });
});

/* ================== SERVER ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`TKAI Backend running on port ${PORT}`);
  await sendTelegram("✅ TKAI Backend started successfully");
});