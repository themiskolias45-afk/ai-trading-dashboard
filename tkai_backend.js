// ================================
// TKAI BACKEND — STABLE BASE
// Node 18 / Express / Render
// Dashboard API + Telegram
// ================================

const express = require("express");
const app = express();

app.use(express.json());

// ================================
// TELEGRAM (KEEP AS IS)
// ================================
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

    const data = await res.json();
    console.log("Telegram sent:", data.ok);
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

// ================================
// ROUTES
// ================================
app.get("/", (req, res) => {
  res.send("TKAI Backend is running");
});

app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    assets: ["BTC", "GOLD", "SP500", "MSFT", "AMZN"],
    time: new Date().toISOString(),
  });
});

// ================================
// SERVER START (RENDER REQUIRED)
// ================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TKAI Backend running on port ${PORT}`);
  sendTelegram("✅ TKAI Backend is LIVE and Telegram is working");
});