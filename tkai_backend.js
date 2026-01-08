// =======================================================
// TKAI — BACKEND SERVER (API + TELEGRAM ENGINE)
// Assets: BTC, GOLD, SP500, MSFT, AMZN
// Scans: Hourly
// Daily Report: 23:00 London
// =======================================================

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const cron = require("node-cron");

// ===================== CONFIG =====================

// 🔴 TELEGRAM (already provided by you)
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

// Assets universe
const ASSETS = ["BTCUSD", "XAUUSD", "SP500", "MSFT", "AMZN"];

// ==================================================

const app = express();
app.use(cors());
app.use(express.json());

// ===================== MOCK AI ENGINE =====================
// (Later this can be replaced with real ML / indicators)

function generateSignal(asset) {
  return {
    asset,
    bias: "Bullish",
    direction: "LONG",
    entry: 43250,
    tp1: 43800,
    tp2: 44500,
    sl: 42800,
    confidence: "A",
    explanation:
      "Bullish market structure, liquidity sweep completed, momentum confirmed on lower timeframe.",
    timestamp: new Date().toISOString()
  };
}

// ===================== API ENDPOINTS =====================

// Health check
app.get("/", (req, res) => {
  res.send("✅ TKAI Backend is running");
});

// 🔥 MAIN DASHBOARD ENDPOINT (THIS WAS MISSING BEFORE)
app.get("/api/status", (req, res) => {
  const signal = generateSignal("BTCUSD");
  res.json(signal);
});

// All assets snapshot
app.get("/api/assets", (req, res) => {
  const data = ASSETS.map(a => generateSignal(a));
  res.json(data);
});

// Manual request (for dashboard / future chat)
app.get("/api/asset/:symbol", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!ASSETS.includes(symbol)) {
    return res.status(404).json({ error: "Asset not supported" });
  }
  res.json(generateSignal(symbol));
});

// ===================== TELEGRAM =====================

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

// ===================== HOURLY SCAN =====================

cron.schedule("0 * * * *", async () => {
  const signal = generateSignal("BTCUSD");

  if (signal.confidence === "A") {
    const msg = `
🤖 <b>TKAI Hourly Signal</b>

Asset: <b>${signal.asset}</b>
Bias: <b>${signal.bias}</b>
Direction: <b>${signal.direction}</b>

Entry: ${signal.entry}
TP1: ${signal.tp1}
TP2: ${signal.tp2}
SL: ${signal.sl}

Confidence: <b>${signal.confidence}</b>

🧠 ${signal.explanation}
`;
    await sendTelegram(msg);
  }
});

// ===================== DAILY REPORT (23:00 LONDON) =====================

cron.schedule("0 23 * * *", async () => {
  let report = "📊 <b>TKAI Daily Market Plan</b>\n\n";

  ASSETS.forEach(asset => {
    const s = generateSignal(asset);
    report += `
<b>${asset}</b>
Bias: ${s.bias}
Direction: ${s.direction}
Entry: ${s.entry}
TP1: ${s.tp1}
TP2: ${s.tp2}
SL: ${s.sl}
Confidence: ${s.confidence}

`;
  });

  await sendTelegram(report);
}, {
  timezone: "Europe/London"
});

// ===================== START SERVER =====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 TKAI backend running on port", PORT);
});