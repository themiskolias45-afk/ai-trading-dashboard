const express = require("express");
const app = express();

// Telegram credentials (ONLY TELEGRAM)
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

async function sendTelegram() {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: "✅ Telegram from server is working"
    })
  });
}

// Render needs a port
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server started");
  sendTelegram();
});