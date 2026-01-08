const express = require("express");
const app = express();

/* Telegram */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIeuUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

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
  } catch (e) {
    console.error(e.message);
  }
}

/* Routes */
app.get("/", (req, res) => {
  res.send("TKAI Backend is running");
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "running",
    time: new Date().toISOString(),
  });
});

/* Server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server started on port", PORT);
  sendTelegram("✅ TKAI Backend is LIVE");
});