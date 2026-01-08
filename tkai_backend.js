// =======================================================
// TKAI BACKEND — FINAL STABLE VERSION (RENDER SAFE)
// Node 18 / Express / Telegram / Proper Port Binding
// =======================================================

const express = require("express");
const app = express();

/* ===================== TELEGRAM (DO NOT REMOVE) ===================== */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIeuUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

/* Safe fetch for Node 18 */
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

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

/* ===================== BASIC ROUTES ===================== */

app.get("/", (req, res) => {
  res.send("TKAI Backend is running");
});

app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    assets: ["BTC", "GOLD (PAXG)", "SP500", "MSFT", "AMZN"],
    time: new Date().toISOString(),
  });
});

/* ===================== SERVER START (CRITICAL) ===================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TKAI Backend listening on port ${PORT}`);
  sendTelegram("✅ TKAI Backend is LIVE on Render");
});