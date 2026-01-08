// TELEGRAM ONLY — NO SERVER — NO EXPRESS

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    })
  });

  const data = await res.json();
  console.log(data);
}

sendTelegram("✅ Telegram ONLY script is working");