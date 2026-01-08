import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ======== PUT YOUR TOKEN HERE ========
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
// ====================================

// ======== SEND MESSAGE ========
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

// ======== HANDLE TELEGRAM MESSAGE ========
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  if (message.text === "/start") {
    await sendMessage(message.chat.id, "✅ Bot is working");
  }

  res.sendStatus(200);
});

// ======== START SERVER ========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot running");
});