/**************************************************
 * TKAI — BACKEND SERVER (STABLE / RENDER READY)
 * Dashboard API + Telegram
 **************************************************/

const express = require("express");
const app = express();

/* ================= SAFE FETCH (Node 18 / Render) ================= */
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* ================= TELEGRAM (DO NOT REMOVE) ================= */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

async function sendTelegram(message) {
  try {
    const res = await fetch(
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

    if (!res.ok) {
      const t = await res.text();
      console.error("Telegram API error:", t);
    }
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

/* ================= DASHBOARD API ================= */
app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    assets: ["BTC", "GOLD (PAXG)", "SP500", "MSFT", "AMZN"],
    time: new Date().toISOString(),
  });
});

/* ================= SERVER (CRITICAL) ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TKAI Backend running on port ${PORT}`);

  setTimeout(() => {
    sendTelegram("✅ TKAI Backend is LIVE and Telegram is working");
  }, 5000);
});