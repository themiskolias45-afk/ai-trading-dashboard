/****************************************************
 * TKAI – BACKEND SERVER (STABLE / RENDER READY)
 * Dashboard API + Telegram Notifications
 ****************************************************/

const express = require("express");

/* ================= SAFE FETCH (Node 18 / Render) ================= */
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

/* ================= TELEGRAM (DO NOT REMOVE) ================= */
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
        parse_mode: "HTML"
      })
    });
    console.log("Telegram message sent");
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

/* ================= API ================= */
app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    assets: ["BTC", "GOLD (PAXG)", "SP500", "MSFT", "AMZN"],
    time: new Date().toISOString()
  });
});

/* ================= SERVER (CRITICAL) ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`TKAI Backend running on port ${PORT}`);

  await sendTelegram(
    "✅ <b>TKAI Backend is LIVE</b>\n\n" +
    "Status: Running\n" +
    "Assets: BTC, GOLD, SP500, MSFT, AMZN\n" +
    "Time: " + new Date().toISOString()
  );
});