/************************************************************
 * TKAI – BACKEND SERVER (STABLE / RENDER READY)
 * Dashboard API + Telegram (CONFIRMED)
 * Node 18 compatible
 ************************************************************/

const express = require("express");
const app = express();

/* ================= SAFE FETCH (Node 18 / Render) ================= */
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* ================= TELEGRAM (DO NOT REMOVE) ================= */
const TELEGRAM_TOKEN =
  "8246792368:AAG8bxkAIeuUddX5PnQjnC6BubqM3p-NeA";
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
  } catch (err) {
    console.error("Telegram error:", err.message);
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

/* ================= ROOT (OPTIONAL) ================= */
app.get("/", (req, res) => {
  res.send("TKAI Backend is running");
});

/* ================= SERVER START (CRITICAL) ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`TKAI Backend running on port ${PORT}`);

  // Telegram confirmation (guaranteed)
  await sendTelegram("✅ TKAI Backend is LIVE and connected");
});