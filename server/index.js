/**
 * SmartEntry Pro Server v8
 * Express API + Telegram Bot + TradingView Webhooks + Daily AI Plan
 * Port: 3001
 */

const express = require("express");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Config ───────────────────────────────────────────────────
const PORT             = process.env.PORT             || 3001;
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const UW_API_KEY       = process.env.UW_API_KEY       || "44f340fd-f440-442f-a97d-d8aae118f06f";
const UW_BASE          = "https://api.unusualwhales.com/api";

const uwHeaders = {
  Authorization: `Bearer ${UW_API_KEY}`,
  Accept: "application/json",
  "User-Agent": "SmartEntry/8.0"
};

// ── State ─────────────────────────────────────────────────────
let priceCache = { btc: null, btcChange: null, gold: null, goldChange: null, spx: null, spxChange: null, updated: null };
let dailyPlan  = null;
let tvAlerts   = [];        // TradingView webhook alerts (last 50)
let congressCache = null;
let flowCache     = null;
let knownChatIds  = new Set();

// ── Price fetching ────────────────────────────────────────────
async function yahooPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const res = await axios.get(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
  const meta = res.data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error("no meta");
  const price  = meta.regularMarketPrice ?? meta.previousClose;
  const prev   = meta.chartPreviousClose ?? meta.previousClose;
  const change = prev ? ((price - prev) / prev) * 100 : 0;
  return { price: parseFloat(price.toFixed(2)), change: parseFloat(change.toFixed(2)) };
}

async function fetchPrices() {
  try {
    const [btcRes, goldRes, spxRes] = await Promise.allSettled([
      axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        { timeout: 8000, headers: { "User-Agent": "SmartEntry/8.0" } }
      ),
      yahooPrice("GC=F"),
      yahooPrice("SPY")
    ]);

    if (btcRes.status === "fulfilled") {
      priceCache.btc       = parseFloat((btcRes.value.data?.bitcoin?.usd ?? priceCache.btc).toFixed(2));
      priceCache.btcChange = parseFloat((btcRes.value.data?.bitcoin?.usd_24h_change ?? 0).toFixed(2));
    }
    if (goldRes.status === "fulfilled") {
      priceCache.gold       = goldRes.value.price;
      priceCache.goldChange = goldRes.value.change;
    }
    if (spxRes.status === "fulfilled") {
      priceCache.spx       = spxRes.value.price;
      priceCache.spxChange = spxRes.value.change;
    }

    priceCache.updated = new Date().toISOString();
    console.log(`[prices] BTC $${priceCache.btc} | Gold $${priceCache.gold} | SPY $${priceCache.spx}`);
  } catch (err) {
    console.error("fetchPrices error:", err.message);
  }
}

// ── Unusual Whales proxy ──────────────────────────────────────
async function fetchCongress() {
  try {
    const res = await axios.get(`${UW_BASE}/congress/trades`, {
      headers: uwHeaders, timeout: 10000,
      params: { limit: 20, ordering: "date" }
    });
    congressCache = res.data;
  } catch (e) {
    console.error("UW congress error:", e.message);
  }
}

async function fetchFlow() {
  try {
    const res = await axios.get(`${UW_BASE}/flow/alerts`, {
      headers: uwHeaders, timeout: 10000,
      params: { limit: 20 }
    });
    flowCache = res.data;
  } catch (e) {
    console.error("UW flow error:", e.message);
  }
}

// ── Daily plan generator ──────────────────────────────────────
function mktBias(change) {
  if (change === null || change === undefined) return "NEUTRAL";
  if (change >  2) return "STRONG BUY";
  if (change >  0) return "BUY";
  if (change < -2) return "STRONG SELL";
  if (change <  0) return "SELL";
  return "NEUTRAL";
}

function biasEmoji(b) {
  return b.includes("STRONG BUY") ? "🟢🟢" : b.includes("BUY") ? "🟢" :
         b.includes("STRONG SELL") ? "🔴🔴" : b.includes("SELL") ? "🔴" : "🟡";
}

function generateDailyPlan() {
  const { btc, btcChange, gold, goldChange, spx, spxChange } = priceCache;
  const btcBias  = mktBias(btcChange);
  const goldBias = mktBias(goldChange);
  const spxBias  = mktBias(spxChange);

  const overall =
    [btcBias, goldBias, spxBias].filter(b => b.includes("BUY")).length >= 2  ? "RISK-ON" :
    [btcBias, goldBias, spxBias].filter(b => b.includes("SELL")).length >= 2 ? "RISK-OFF" :
    "MIXED";

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const plan = {
    date: dateStr,
    generated: now.toISOString(),
    regime: overall,
    markets: {
      btc:  { price: btc,  change: btcChange,  bias: btcBias  },
      gold: { price: gold, change: goldChange, bias: goldBias },
      spx:  { price: spx,  change: spxChange,  bias: spxBias  }
    },
    watchlist: buildWatchlist(btcBias, goldBias, spxBias, overall),
    rules: buildRules(overall),
    levels: buildLevels(btc, gold, spx)
  };

  dailyPlan = plan;
  console.log(`[plan] Generated for ${dateStr} — regime: ${overall}`);
  return plan;
}

function buildWatchlist(btcBias, goldBias, spxBias, overall) {
  const list = [];
  if (btcBias.includes("BUY"))  list.push({ ticker: "BTC/USD", reason: `Bullish momentum (${priceCache.btcChange > 0 ? "+" : ""}${priceCache.btcChange}% 24h)`, action: "LONG", priority: "HIGH" });
  if (btcBias.includes("SELL")) list.push({ ticker: "BTC/USD", reason: `Bearish pressure (${priceCache.btcChange}% 24h)`, action: "SHORT / AVOID", priority: "HIGH" });
  if (goldBias.includes("BUY"))  list.push({ ticker: "XAUUSD", reason: `Gold bid — safe-haven demand`, action: "LONG", priority: overall === "RISK-OFF" ? "HIGH" : "MEDIUM" });
  if (goldBias.includes("SELL")) list.push({ ticker: "XAUUSD", reason: `Gold fading — risk appetite rising`, action: "WATCH SUPPORT", priority: "MEDIUM" });
  if (spxBias.includes("BUY"))   list.push({ ticker: "SPY", reason: `Equities bid`, action: "LONG equities", priority: "MEDIUM" });
  if (spxBias.includes("SELL"))  list.push({ ticker: "SPY", reason: `Equity weakness`, action: "REDUCE exposure", priority: "HIGH" });
  if (list.length === 0) list.push({ ticker: "ALL", reason: "No clear directional signal today", action: "WAIT / CASH", priority: "LOW" });
  return list;
}

function buildRules(regime) {
  const base = [
    "Never risk more than 1-2% of capital per trade",
    "Only enter after confirmed signal — no anticipation",
    "Set stop-loss before entering any position"
  ];
  if (regime === "RISK-ON")  return [...base, "Favour long setups — trend is your friend", "Trail stops on winners"];
  if (regime === "RISK-OFF") return [...base, "Reduce size — protect capital", "Cash is a position", "Look for short setups only on confirmed breakdowns"];
  return [...base, "Reduce size in mixed market — be selective", "Wait for clarity before adding new positions"];
}

function buildLevels(btc, gold, spx) {
  const levels = {};
  if (btc)  levels.btc  = { support: Math.round(btc  * 0.97), resistance: Math.round(btc  * 1.03) };
  if (gold) levels.gold = { support: parseFloat((gold * 0.97).toFixed(1)), resistance: parseFloat((gold * 1.03).toFixed(1)) };
  if (spx)  levels.spx  = { support: parseFloat((spx  * 0.97).toFixed(2)), resistance: parseFloat((spx  * 1.03).toFixed(2)) };
  return levels;
}

// ── API: Status ───────────────────────────────────────────────
app.get("/api/status", (req, res) => res.json({ status: "online", version: 8, ...priceCache }));
app.get("/api/health", (req, res) => res.json({ ok: true, version: 8, ts: Date.now() }));

// ── API: Daily plan ───────────────────────────────────────────
app.get("/api/plan", (req, res) => {
  if (!dailyPlan) generateDailyPlan();
  res.json(dailyPlan);
});

app.post("/api/plan/refresh", (req, res) => {
  generateDailyPlan();
  res.json({ ok: true, plan: dailyPlan });
});

// ── API: TradingView webhook ──────────────────────────────────
app.post("/api/tv-alert", (req, res) => {
  const body = req.body;
  const alert = {
    id: Date.now(),
    ts: new Date().toISOString(),
    ticker:  body.ticker  || body.symbol || "UNKNOWN",
    action:  body.action  || body.strategy?.order_action || body.message || "ALERT",
    price:   body.price   || body.close  || null,
    message: body.message || JSON.stringify(body)
  };
  tvAlerts.unshift(alert);
  if (tvAlerts.length > 50) tvAlerts = tvAlerts.slice(0, 50);
  console.log(`[tv-alert] ${alert.ticker} — ${alert.action}`);

  // Forward to Telegram
  for (const chatId of knownChatIds) {
    const text =
      `🔔 <b>TradingView Alert</b>\n\n` +
      `Ticker: <b>${alert.ticker}</b>\n` +
      `Signal: <b>${alert.action}</b>\n` +
      (alert.price ? `Price: <b>$${alert.price}</b>\n` : "") +
      `Time: ${new Date(alert.ts).toLocaleTimeString()}`;
    sendTelegram(chatId, text).catch(() => {});
  }

  res.json({ ok: true, alert });
});

app.get("/api/alerts", (req, res) => res.json({ alerts: tvAlerts }));

// ── API: Congress proxy ───────────────────────────────────────
app.get("/api/congress", async (req, res) => {
  if (!congressCache) await fetchCongress();
  res.json(congressCache ?? { data: [] });
});

// ── API: Flow proxy ───────────────────────────────────────────
app.get("/api/flow", async (req, res) => {
  if (!flowCache) await fetchFlow();
  res.json(flowCache ?? { data: [] });
});

// ── Telegram ──────────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true },
      { timeout: 5000 }
    );
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

function planToTelegram(plan) {
  const { regime, markets, watchlist, rules, levels } = plan;
  const e = biasEmoji(regime === "RISK-ON" ? "BUY" : regime === "RISK-OFF" ? "SELL" : "NEUTRAL");

  let msg = `📋 <b>DAILY TRADING PLAN</b>\n${plan.date}\n\n`;
  msg += `Regime: <b>${e} ${regime}</b>\n\n`;
  msg += `📊 <b>Markets</b>\n`;
  msg += `BTC:  $${markets.btc.price?.toLocaleString() ?? "N/A"} (${markets.btc.change > 0 ? "+" : ""}${markets.btc.change ?? 0}%) — <b>${markets.btc.bias}</b>\n`;
  msg += `Gold: $${markets.gold.price?.toLocaleString() ?? "N/A"} (${markets.gold.change > 0 ? "+" : ""}${markets.gold.change ?? 0}%) — <b>${markets.gold.bias}</b>\n`;
  msg += `SPY:  $${markets.spx.price?.toLocaleString() ?? "N/A"} (${markets.spx.change > 0 ? "+" : ""}${markets.spx.change ?? 0}%) — <b>${markets.spx.bias}</b>\n\n`;
  msg += `🎯 <b>Watchlist</b>\n`;
  watchlist.forEach(w => { msg += `• ${w.ticker} — ${w.action} [${w.priority}]\n`; });
  msg += `\n📐 <b>Key Levels</b>\n`;
  if (levels.btc)  msg += `BTC:  S $${levels.btc.support.toLocaleString()} / R $${levels.btc.resistance.toLocaleString()}\n`;
  if (levels.gold) msg += `Gold: S $${levels.gold.support} / R $${levels.gold.resistance}\n`;
  if (levels.spx)  msg += `SPY:  S $${levels.spx.support} / R $${levels.spx.resistance}\n`;
  msg += `\n⚠️ <b>Rules</b>\n`;
  rules.slice(0, 3).forEach(r => { msg += `• ${r}\n`; });
  return msg;
}

async function handleMessage(message) {
  if (!message?.text) return;
  const chatId = message.chat.id;
  knownChatIds.add(chatId);
  const text = message.text.trim().toLowerCase();

  if (text === "/start") {
    await sendTelegram(chatId,
      "✅ <b>SmartEntry Pro v8 active</b>\n\n" +
      "Commands:\n/plan — today's trading plan\n/btc — BTC analysis\n/gold — gold price\n/spx — S&amp;P 500\n/daily — full market report"
    );
  } else if (text === "/plan") {
    if (!dailyPlan) generateDailyPlan();
    await sendTelegram(chatId, planToTelegram(dailyPlan));
  } else if (text === "/btc") {
    await fetchPrices();
    const { btc, btcChange } = priceCache;
    const bias = mktBias(btcChange);
    await sendTelegram(chatId,
      `📊 <b>BTC ANALYSIS</b>\n\nPrice: <b>$${(btc ?? 0).toLocaleString()}</b>\n` +
      `24h: <b>${btcChange > 0 ? "+" : ""}${btcChange}%</b>\nBias: <b>${bias}</b>\n\n` +
      `Support: $${Math.round((btc ?? 0) * 0.97).toLocaleString()}\nResistance: $${Math.round((btc ?? 0) * 1.03).toLocaleString()}`
    );
  } else if (text === "/gold") {
    await fetchPrices();
    const { gold, goldChange } = priceCache;
    await sendTelegram(chatId,
      `🪙 <b>GOLD</b>\n\nPrice: <b>$${gold?.toLocaleString() ?? "N/A"}</b>\n` +
      `24h: <b>${goldChange > 0 ? "+" : ""}${goldChange ?? 0}%</b>\nBias: <b>${mktBias(goldChange)}</b>`
    );
  } else if (text === "/spx") {
    await fetchPrices();
    const { spx, spxChange } = priceCache;
    await sendTelegram(chatId,
      `📈 <b>S&amp;P 500 (SPY)</b>\n\nPrice: <b>$${spx?.toLocaleString() ?? "N/A"}</b>\n` +
      `24h: <b>${spxChange > 0 ? "+" : ""}${spxChange ?? 0}%</b>\nBias: <b>${mktBias(spxChange)}</b>`
    );
  } else if (text === "/daily") {
    await fetchPrices();
    const { btc, btcChange, gold, goldChange, spx, spxChange } = priceCache;
    await sendTelegram(chatId,
      `🗓 <b>MARKET REPORT</b>\n\n` +
      `BTC:  <b>$${(btc ?? 0).toLocaleString()}</b> (${btcChange > 0 ? "+" : ""}${btcChange ?? 0}%)\n` +
      `Gold: <b>$${gold?.toLocaleString() ?? "N/A"}</b> (${goldChange > 0 ? "+" : ""}${goldChange ?? 0}%)\n` +
      `SPY:  <b>$${spx?.toLocaleString() ?? "N/A"}</b> (${spxChange > 0 ? "+" : ""}${spxChange ?? 0}%)`
    );
  }
}

let lastUpdateId = 0;
async function pollTelegram() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      { timeout: 15000 }
    );
    for (const update of res.data?.result ?? []) {
      lastUpdateId = update.update_id;
      if (update.message) await handleMessage(update.message);
    }
  } catch (e) {
    console.error("Polling error:", e.message);
  }
}

// ── Scheduled jobs ────────────────────────────────────────────
// Generate plan + send to Telegram at 7:00 AM every day
cron.schedule("0 7 * * *", async () => {
  await fetchPrices();
  await fetchCongress();
  await fetchFlow();
  generateDailyPlan();
  for (const chatId of knownChatIds) {
    await sendTelegram(chatId, planToTelegram(dailyPlan));
  }
  console.log("[cron] Morning plan sent");
});

// Refresh prices every 60 seconds
cron.schedule("* * * * *", fetchPrices);

// Refresh UW data every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  await fetchCongress();
  await fetchFlow();
});

// ── Boot ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ SmartEntry Pro v8 on port ${PORT}`);
  await fetchPrices();
  await fetchCongress();
  await fetchFlow();
  generateDailyPlan();
  setInterval(pollTelegram, 3000);
});
