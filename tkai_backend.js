/**************************************************
 * TKAI – BACKEND SERVER (STABLE BASE)
 * Render-compatible | Dashboard + Telegram
 **************************************************/

const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

/* ================== TELEGRAM ================== */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
    console.log("Telegram sent");
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

/* ================== API ================== */
app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    assets: ["BTC", "GOLD", "SP500", "MSFT", "AMZN"],
    time: new Date().toISOString(),
  });
});

/* ================== SERVER ================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TKAI Backend running on port ${PORT}`);
  sendTelegram("✅ TKAI Backend is LIVE and running");
});