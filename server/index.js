/**
 * SmartEntry Pro Server v10
 * Real TA + Claude AI analysis + Ask Claude chat
 * Port: 3001
 */

const express    = require("express");
const axios      = require("axios");
const cron       = require("node-cron");
const Anthropic  = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Config ────────────────────────────────────────────────────
const PORT             = process.env.PORT             || 3001;
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || "";
const UW_API_KEY       = process.env.UW_API_KEY       || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const UW_BASE        = "https://api.unusualwhales.com/api";
const uwHeaders      = { Authorization: `Bearer ${UW_API_KEY}`, Accept: "application/json", "User-Agent": "SmartEntry/9.0" };

// ── State ─────────────────────────────────────────────────────
let priceCache    = { btc: null, btcChange: null, gold: null, goldChange: null, spx: null, spxChange: null, updated: null };
let signalCache   = { btc: null, gold: null, spx: null, updatedAt: null };
let dailyPlan     = null;
let tvAlerts      = [];
let congressCache = null;
let flowCache     = null;
let knownChatIds  = new Set();

// ══════════════════════════════════════════════════════════════
//  TECHNICAL ANALYSIS
// ══════════════════════════════════════════════════════════════

function emaSeries(closes, period) {
  const k = 2 / (period + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] * k + out[i - 1] * (1 - k));
  return out;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return {
    upper:     parseFloat((mean + mult * std).toFixed(2)),
    middle:    parseFloat(mean.toFixed(2)),
    lower:     parseFloat((mean - mult * std).toFixed(2)),
    bandwidth: parseFloat(((mult * 2 * std) / mean * 100).toFixed(1))
  };
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = emaSeries(macdLine, 9);
  const last = macdLine.length - 1;
  const prev = last - 1;
  return {
    macd:      parseFloat(macdLine[last].toFixed(2)),
    signal:    parseFloat(signalLine[last].toFixed(2)),
    histogram: parseFloat((macdLine[last] - signalLine[last]).toFixed(2)),
    crossed:   macdLine[last] > signalLine[last] && macdLine[prev] <= signalLine[prev],
    bullish:   macdLine[last] > signalLine[last]
  };
}

function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── Core signal generator ─────────────────────────────────────
function generateSignal(label, ticker, closes, highs, lows) {
  if (!closes || closes.length < 50) return null;

  const price  = closes[closes.length - 1];
  const rsi    = calcRSI(closes);
  const bb     = calcBB(closes);
  const macd   = calcMACD(closes);
  const atrVal = atr(highs, lows, closes);

  const ema20  = emaSeries(closes, 20).at(-1);
  const ema50  = emaSeries(closes, 50).at(-1);
  const ema200 = closes.length >= 200 ? emaSeries(closes, 200).at(-1) : null;

  const aboveEma20  = price > ema20;
  const aboveEma50  = price > ema50;
  const aboveEma200 = ema200 ? price > ema200 : null;

  const trend =
    aboveEma200 === true  && aboveEma50 && aboveEma20  ? "STRONG UPTREND" :
    aboveEma200 === true  && aboveEma50                ? "UPTREND" :
    aboveEma200 === false && !aboveEma50 && !aboveEma20 ? "STRONG DOWNTREND" :
    aboveEma200 === false && !aboveEma50               ? "DOWNTREND" : "MIXED";

  // ── Signal logic ──
  let setup = "WAIT", signal = "WAIT", strength = "NONE";
  let entry = price, stop = null, target = null, reasons = [];

  const stopPct  = ticker === "BTC-USD" ? 0.03 : 0.015;   // BTC 3%, Gold 1.5%
  const targetMult = 2.5;

  // LONG setups
  if (
    (aboveEma200 === true || aboveEma200 === null) &&
    aboveEma50 &&
    !aboveEma20 &&
    rsi < 45 &&
    macd?.bullish
  ) {
    setup  = "BUY_DIP";
    signal = "BUY";
    strength = rsi < 35 ? "STRONG" : "MODERATE";
    stop   = parseFloat((ema50 * 0.99).toFixed(2));
    target = parseFloat((bb?.upper ?? price * 1.05).toFixed(2));
    reasons.push(`Above EMA50/200 (uptrend intact)`);
    reasons.push(`RSI ${rsi} — oversold dip`);
    reasons.push(`Pulling back to EMA20 support`);
    if (macd.crossed) reasons.push(`MACD bullish crossover confirmed`);
  }
  else if (
    (aboveEma200 === true || aboveEma200 === null) &&
    !aboveEma50 &&
    rsi < 35 &&
    bb && price <= bb.lower
  ) {
    setup  = "BUY_OVERSOLD";
    signal = "BUY";
    strength = "MODERATE";
    stop   = parseFloat((price * (1 - stopPct)).toFixed(2));
    target = parseFloat((bb.middle).toFixed(2));
    reasons.push(`RSI ${rsi} — deeply oversold`);
    reasons.push(`Price at Bollinger lower band`);
    reasons.push(`Mean-reversion setup to BB middle`);
  }
  // SELL setups
  else if (
    aboveEma200 === false &&
    !aboveEma50 &&
    aboveEma20 &&
    rsi > 55 &&
    macd && !macd.bullish
  ) {
    setup  = "SELL_BOUNCE";
    signal = "SELL";
    strength = rsi > 65 ? "STRONG" : "MODERATE";
    stop   = parseFloat((ema20 * 1.01).toFixed(2));
    target = parseFloat((bb?.lower ?? price * 0.95).toFixed(2));
    reasons.push(`Below EMA200/50 (downtrend)`);
    reasons.push(`RSI ${rsi} — overbought bounce`);
    reasons.push(`Rejection at EMA20 resistance`);
  }
  // BREAKOUT
  else if (
    ema200 &&
    Math.abs(price - ema200) / ema200 < 0.005 &&
    rsi > 50 && rsi < 65 &&
    macd?.bullish &&
    bb && bb.bandwidth < 15
  ) {
    setup  = "BREAKOUT";
    signal = "BUY";
    strength = "MODERATE";
    stop   = parseFloat((ema200 * 0.985).toFixed(2));
    target = parseFloat((price * 1.06).toFixed(2));
    reasons.push(`Testing EMA200 — key breakout level`);
    reasons.push(`Bollinger squeeze (bandwidth ${bb.bandwidth}%) — energy building`);
    reasons.push(`MACD bullish + RSI above 50`);
  }
  else {
    // WAIT — no setup
    reasons.push(`RSI ${rsi} — no extreme reading`);
    reasons.push(`Price between key EMAs — wait for clarity`);
    if (bb && bb.bandwidth < 12) reasons.push(`Bollinger squeeze forming — breakout incoming`);
  }

  // Risk/reward
  const rr = (stop && target)
    ? Math.abs(target - entry) / Math.abs(entry - stop)
    : null;

  return {
    label,
    ticker,
    price,
    signal,
    setup,
    strength,
    entry:  parseFloat(entry.toFixed(2)),
    stop:   stop   ? parseFloat(stop.toFixed(2))   : null,
    target: target ? parseFloat(target.toFixed(2)) : null,
    rr:     rr     ? parseFloat(rr.toFixed(1))     : null,
    indicators: {
      rsi,
      ema20:  parseFloat(ema20.toFixed(2)),
      ema50:  parseFloat(ema50.toFixed(2)),
      ema200: ema200 ? parseFloat(ema200.toFixed(2)) : null,
      bb,
      macd
    },
    trend,
    reasons,
    updatedAt: new Date().toISOString()
  };
}

// ══════════════════════════════════════════════════════════════
//  DATA FETCHING
// ══════════════════════════════════════════════════════════════

async function fetchCandles(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=210d`;
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
  });
  const result = res.data?.chart?.result?.[0];
  if (!result) throw new Error("No chart data");
  const quote  = result.indicators.quote[0];
  const closes = quote.close.map(v => v ?? null).filter(v => v !== null);
  const highs  = quote.high.map(v  => v ?? null).filter(v => v !== null);
  const lows   = quote.low.map(v   => v ?? null).filter(v => v !== null);
  return { closes, highs, lows, meta: result.meta };
}

async function yahooPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const res  = await axios.get(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
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
      axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        { timeout: 8000, headers: { "User-Agent": "SmartEntry/9.0" } }),
      yahooPrice("GC=F"),
      yahooPrice("SPY")
    ]);
    if (btcRes.status === "fulfilled") {
      priceCache.btc       = parseFloat((btcRes.value.data?.bitcoin?.usd ?? priceCache.btc).toFixed(2));
      priceCache.btcChange = parseFloat((btcRes.value.data?.bitcoin?.usd_24h_change ?? 0).toFixed(2));
    }
    if (goldRes.status === "fulfilled") { priceCache.gold = goldRes.value.price; priceCache.goldChange = goldRes.value.change; }
    if (spxRes.status  === "fulfilled") { priceCache.spx  = spxRes.value.price;  priceCache.spxChange  = spxRes.value.change; }
    priceCache.updated = new Date().toISOString();
    console.log(`[prices] BTC $${priceCache.btc} | Gold $${priceCache.gold} | SPY $${priceCache.spx}`);
  } catch (e) { console.error("fetchPrices:", e.message); }
}

async function refreshSignals() {
  console.log("[signals] Refreshing technical analysis…");
  const assets = [
    { key: "btc",  label: "Bitcoin",    symbol: "BTC-USD" },
    { key: "gold", label: "Gold/XAUUSD", symbol: "GC=F"   },
    { key: "spx",  label: "S&P500/SPY", symbol: "SPY"     }
  ];
  for (const a of assets) {
    try {
      const { closes, highs, lows } = await fetchCandles(a.symbol);
      signalCache[a.key] = generateSignal(a.label, a.symbol, closes, highs, lows);
      console.log(`[signals] ${a.label}: ${signalCache[a.key]?.signal} (${signalCache[a.key]?.strength})`);
    } catch (e) {
      console.error(`[signals] ${a.label} error:`, e.message);
    }
  }
  signalCache.updatedAt = new Date().toISOString();
  refreshAnalysis();
}

// ── Unusual Whales ────────────────────────────────────────────
async function fetchCongress() {
  try {
    const res = await axios.get(`${UW_BASE}/congress/trades`, { headers: uwHeaders, timeout: 10000, params: { limit: 20 } });
    congressCache = res.data;
  } catch (e) { console.error("UW congress:", e.message); }
}

async function fetchFlow() {
  try {
    const res = await axios.get(`${UW_BASE}/flow/alerts`, { headers: uwHeaders, timeout: 10000, params: { limit: 20 } });
    flowCache = res.data;
  } catch (e) { console.error("UW flow:", e.message); }
}

// ══════════════════════════════════════════════════════════════
//  PLAN GENERATOR
// ══════════════════════════════════════════════════════════════

function mktBias(change) {
  if (!change) return "NEUTRAL";
  return change > 2 ? "STRONG BUY" : change > 0 ? "BUY" : change < -2 ? "STRONG SELL" : "SELL";
}

function generateDailyPlan() {
  const { btc, btcChange, gold, goldChange, spx, spxChange } = priceCache;
  const signals = [signalCache.btc, signalCache.gold, signalCache.spx].filter(Boolean);

  const buyCount  = signals.filter(s => s.signal === "BUY").length;
  const sellCount = signals.filter(s => s.signal === "SELL").length;
  const regime    = buyCount >= 2 ? "RISK-ON" : sellCount >= 2 ? "RISK-OFF" : "MIXED";

  const now = new Date();
  dailyPlan = {
    date:     now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    generated: now.toISOString(),
    regime,
    markets: {
      btc:  { price: btc,  change: btcChange,  bias: mktBias(btcChange)  },
      gold: { price: gold, change: goldChange, bias: mktBias(goldChange) },
      spx:  { price: spx,  change: spxChange,  bias: mktBias(spxChange)  }
    },
    signals: {
      btc:  signalCache.btc,
      gold: signalCache.gold,
      spx:  signalCache.spx
    },
    rules: buildRules(regime)
  };
  console.log(`[plan] ${regime} — ${now.toISOString()}`);
  return dailyPlan;
}

function buildRules(regime) {
  const base = [
    "Never risk more than 1-2% of capital per trade",
    "Set stop-loss BEFORE entering — no exceptions",
    "Only enter after signal confirms on your chart"
  ];
  if (regime === "RISK-ON")  return [...base, "Favour long setups — trend is your friend", "Trail stops on winners"];
  if (regime === "RISK-OFF") return [...base, "Reduce size — capital protection first", "Cash is a valid position"];
  return [...base, "Be selective in mixed conditions — fewer, higher-quality trades only"];
}

// ══════════════════════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════════════════════

async function sendTelegram(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true },
      { timeout: 5000 });
  } catch (e) { console.error("Telegram:", e.message); }
}

function signalToTelegram(s) {
  if (!s) return "⚠️ Signal not available.";
  const emoji = s.signal === "BUY" ? "🟢" : s.signal === "SELL" ? "🔴" : "🟡";
  const strengthEmoji = s.strength === "STRONG" ? "💪" : s.strength === "MODERATE" ? "👍" : "";

  let msg = `${emoji} <b>${s.label} — ${s.signal} ${strengthEmoji}</b>\n`;
  msg += `Setup: <b>${s.setup.replace(/_/g," ")}</b> (${s.trend})\n\n`;
  msg += `💰 Price: <b>$${s.price?.toLocaleString()}</b>\n`;
  if (s.signal !== "WAIT") {
    msg += `🎯 Entry:  <b>$${s.entry?.toLocaleString()}</b>\n`;
    msg += `🛑 Stop:   <b>$${s.stop?.toLocaleString()}</b>\n`;
    msg += `✅ Target: <b>$${s.target?.toLocaleString()}</b>\n`;
    if (s.rr) msg += `⚖️ R/R:    <b>1:${s.rr}</b>\n`;
  }
  msg += `\n📊 <b>Indicators</b>\n`;
  msg += `RSI(14): <b>${s.indicators.rsi}</b>\n`;
  msg += `EMA20: $${s.indicators.ema20?.toLocaleString()} | EMA50: $${s.indicators.ema50?.toLocaleString()}\n`;
  if (s.indicators.ema200) msg += `EMA200: $${s.indicators.ema200?.toLocaleString()}\n`;
  if (s.indicators.macd) msg += `MACD: ${s.indicators.macd.bullish ? "📈 Bullish" : "📉 Bearish"} (hist: ${s.indicators.macd.histogram})\n`;
  if (s.indicators.bb)   msg += `BB: ${s.indicators.bb.lower} / ${s.indicators.bb.middle} / ${s.indicators.bb.upper}\n`;
  msg += `\n💡 <b>Why this setup</b>\n`;
  s.reasons.forEach(r => { msg += `• ${r}\n`; });
  return msg;
}

function planToTelegram(plan) {
  const { regime, date, markets, signals, rules } = plan;
  const e = regime === "RISK-ON" ? "🟢" : regime === "RISK-OFF" ? "🔴" : "🟡";
  let msg = `📋 <b>DAILY TRADING PLAN</b>\n${date}\n\n`;
  msg += `Regime: <b>${e} ${regime}</b>\n\n`;
  msg += `📊 <b>Markets</b>\n`;
  msg += `BTC:  $${markets.btc.price?.toLocaleString()} (${markets.btc.change > 0 ? "+" : ""}${markets.btc.change ?? 0}%) — <b>${markets.btc.bias}</b>\n`;
  msg += `Gold: $${markets.gold.price?.toLocaleString()} (${markets.gold.change > 0 ? "+" : ""}${markets.gold.change ?? 0}%) — <b>${markets.gold.bias}</b>\n`;
  msg += `SPY:  $${markets.spx.price?.toLocaleString()} (${markets.spx.change > 0 ? "+" : ""}${markets.spx.change ?? 0}%) — <b>${markets.spx.bias}</b>\n\n`;

  if (signals?.btc  && signals.btc.signal  !== "WAIT") msg += signalToTelegram(signals.btc)  + "\n";
  if (signals?.gold && signals.gold.signal !== "WAIT") msg += signalToTelegram(signals.gold) + "\n";

  msg += `⚠️ <b>Rules</b>\n`;
  rules.forEach(r => { msg += `• ${r}\n`; });
  return msg;
}

async function handleMessage(message) {
  if (!message?.text) return;
  const chatId = message.chat.id;
  knownChatIds.add(chatId);
  const text = message.text.trim().toLowerCase();

  const cmds = {
    "/start": async () => sendTelegram(chatId,
      "✅ <b>SmartEntry Pro v9 active</b>\n\n" +
      "/plan — full daily plan with entries\n/btc — BTC signal + entry\n/gold — Gold signal + entry\n/spx — SPY signal\n/signals — refresh all signals\n/daily — price summary"
    ),
    "/plan": async () => {
      if (!dailyPlan) generateDailyPlan();
      await sendTelegram(chatId, planToTelegram(dailyPlan));
    },
    "/btc": async () => {
      if (!signalCache.btc) await refreshSignals();
      await sendTelegram(chatId, signalToTelegram(signalCache.btc));
    },
    "/gold": async () => {
      if (!signalCache.gold) await refreshSignals();
      await sendTelegram(chatId, signalToTelegram(signalCache.gold));
    },
    "/spx": async () => {
      if (!signalCache.spx) await refreshSignals();
      await sendTelegram(chatId, signalToTelegram(signalCache.spx));
    },
    "/signals": async () => {
      await sendTelegram(chatId, "🔄 Refreshing signals — takes ~15 seconds…");
      await refreshSignals();
      generateDailyPlan();
      for (const s of [signalCache.btc, signalCache.gold, signalCache.spx]) {
        if (s) await sendTelegram(chatId, signalToTelegram(s));
      }
    },
    "/daily": async () => {
      await fetchPrices();
      const { btc, btcChange, gold, goldChange, spx, spxChange } = priceCache;
      await sendTelegram(chatId,
        `🗓 <b>MARKET SNAPSHOT</b>\n\n` +
        `BTC:  <b>$${(btc ?? 0).toLocaleString()}</b> (${btcChange > 0 ? "+" : ""}${btcChange ?? 0}%)\n` +
        `Gold: <b>$${gold?.toLocaleString() ?? "N/A"}</b> (${goldChange > 0 ? "+" : ""}${goldChange ?? 0}%)\n` +
        `SPY:  <b>$${spx?.toLocaleString() ?? "N/A"}</b> (${spxChange > 0 ? "+" : ""}${spxChange ?? 0}%)`
      );
    }
  };

  if (cmds[text]) await cmds[text]();
}

let lastUpdateId = 0;
async function pollTelegram() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      { timeout: 15000 }
    );
    for (const u of res.data?.result ?? []) {
      lastUpdateId = u.update_id;
      if (u.message) await handleMessage(u.message);
    }
  } catch (e) { console.error("Polling:", e.message); }
}

// ══════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════

app.get("/api/status",  (_, res) => res.json({ status: "online", version: 9, ...priceCache }));
app.get("/api/health",  (_, res) => res.json({ ok: true, version: 9, ts: Date.now() }));
app.get("/api/signals", (_, res) => res.json(signalCache));
app.get("/api/plan",    (_, res) => {
  if (!dailyPlan) generateDailyPlan();
  res.json(dailyPlan);
});
app.post("/api/plan/refresh", async (_, res) => {
  await refreshSignals();
  generateDailyPlan();
  res.json({ ok: true, plan: dailyPlan });
});
app.post("/api/tv-alert", (req, res) => {
  const body  = req.body;
  const alert = {
    id: Date.now(), ts: new Date().toISOString(),
    ticker:  body.ticker  || body.symbol  || "UNKNOWN",
    action:  body.action  || body.message || "ALERT",
    price:   body.price   || body.close   || null,
    message: body.message || JSON.stringify(body)
  };
  tvAlerts.unshift(alert);
  if (tvAlerts.length > 50) tvAlerts = tvAlerts.slice(0, 50);
  for (const cid of knownChatIds) {
    sendTelegram(cid,
      `🔔 <b>TradingView Alert</b>\n\nTicker: <b>${alert.ticker}</b>\nSignal: <b>${alert.action}</b>` +
      (alert.price ? `\nPrice: <b>$${alert.price}</b>` : "") +
      `\nTime: ${new Date(alert.ts).toLocaleTimeString()}`
    ).catch(() => {});
  }
  res.json({ ok: true, alert });
});
app.get("/api/alerts",   (_, res) => res.json({ alerts: tvAlerts }));
app.get("/api/congress", async (_, res) => { if (!congressCache) await fetchCongress(); res.json(congressCache ?? { data: [] }); });
app.get("/api/flow",     async (_, res) => { if (!flowCache)     await fetchFlow();     res.json(flowCache     ?? { data: [] }); });

app.get("/api/analysis", (_, res) => {
  if (!analysisCache.updatedAt) refreshAnalysis();
  res.json(analysisCache);
});

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const reply = await askClaude(message);
    res.json({ reply, context: buildMarketContext() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  SCHEDULED JOBS
// ══════════════════════════════════════════════════════════════

// 6:45 AM — refresh signals before market open
cron.schedule("45 6 * * *", async () => {
  await fetchPrices();
  await refreshSignals();
  await fetchCongress();
  await fetchFlow();
  generateDailyPlan();
  console.log("[cron] 6:45 AM — plan ready");
});

// 7:00 AM — send morning plan to Telegram
cron.schedule("0 7 * * *", async () => {
  for (const cid of knownChatIds) await sendTelegram(cid, planToTelegram(dailyPlan));
  console.log("[cron] 7:00 AM — plan sent");
});

// Every 4 hours — refresh signals (catches intraday setups)
cron.schedule("0 */4 * * *", async () => {
  await fetchPrices();
  await refreshSignals();
  generateDailyPlan();
  // Alert if strong signal appeared
  for (const key of ["btc", "gold"]) {
    const s = signalCache[key];
    if (s && s.signal !== "WAIT" && s.strength === "STRONG") {
      for (const cid of knownChatIds) await sendTelegram(cid, `⚡ <b>STRONG SIGNAL DETECTED</b>\n\n` + signalToTelegram(s));
    }
  }
});

// Every 60s — price refresh
cron.schedule("* * * * *", fetchPrices);

// Every 15 min — UW data
cron.schedule("*/15 * * * *", async () => { await fetchCongress(); await fetchFlow(); });

// ══════════════════════════════════════════════════════════════
//  AUTO-ANALYSIS ENGINE (works without Claude API key)
// ══════════════════════════════════════════════════════════════

function rsiRead(rsi) {
  if (!rsi) return "neutral";
  if (rsi < 25) return "extremely oversold — strong bounce candidate";
  if (rsi < 35) return "oversold — dip buying zone";
  if (rsi < 45) return "mildly oversold — slight bullish lean";
  if (rsi > 75) return "extremely overbought — reversal risk high";
  if (rsi > 65) return "overbought — watch for rejection";
  if (rsi > 55) return "mildly overbought — slight bearish lean";
  return "neutral — no momentum extreme";
}

function autoAnalyze(s) {
  if (!s) return null;
  const { label, signal, strength, setup, trend, entry, stop, target, rr, indicators, reasons } = s;
  const { rsi, ema20, ema50, ema200, macd, bb } = indicators ?? {};
  const price = s.price;

  const lines = [];

  // Headline
  if (signal === "WAIT") {
    lines.push(`**${label} — No Trade Setup Right Now**`);
    lines.push(`The market is in a ${trend} phase with RSI at ${rsi} (${rsiRead(rsi)}). Price is between key levels — no edge to trade.`);
    lines.push(`**What to watch:** Wait for RSI to reach below 35 (oversold) or above 65 (overbought) with a clear EMA break. Patience here protects capital.`);
  } else {
    const dir = signal === "BUY" ? "Long" : "Short";
    lines.push(`**${label} — ${strength} ${signal} Setup (${setup.replace(/_/g," ")})**`);
    lines.push(`Trend: ${trend}. This is a ${strength.toLowerCase()} ${dir.toLowerCase()} opportunity based on ${reasons?.[0]?.toLowerCase() ?? "technical confluence"}.`);

    lines.push(`\n**Trade Plan:**`);
    lines.push(`• Entry: $${entry?.toLocaleString()}`);
    lines.push(`• Stop Loss: $${stop?.toLocaleString()} — place this BEFORE entering`);
    lines.push(`• Target: $${target?.toLocaleString()}`);
    lines.push(`• Risk/Reward: 1:${rr} — ${rr >= 2 ? "good ratio, worth taking" : "acceptable but keep size small"}`);

    lines.push(`\n**Why this setup works:**`);
    reasons?.forEach(r => lines.push(`• ${r}`));

    lines.push(`\n**Indicators:**`);
    lines.push(`• RSI ${rsi}: ${rsiRead(rsi)}`);
    if (macd) lines.push(`• MACD: ${macd.bullish ? "Bullish" : "Bearish"} (histogram ${macd.histogram > 0 ? "+" : ""}${macd.histogram})`);
    if (bb) lines.push(`• Bollinger Bands: width ${bb.bandwidth}% — ${bb.bandwidth < 10 ? "squeeze, breakout likely soon" : "normal volatility"}`);
    if (ema200) lines.push(`• EMA200 at $${ema200?.toLocaleString()} — ${price > ema200 ? "price above, uptrend confirmed" : "price below, downtrend"}`);

    lines.push(`\n**Risk reminder:** Never risk more than 1-2% of your account on this trade. Set your stop the moment you enter — no exceptions.`);
  }

  return lines.join("\n");
}

let analysisCache = { btc: null, gold: null, spx: null, updatedAt: null };

function refreshAnalysis() {
  analysisCache = {
    btc:  autoAnalyze(signalCache.btc),
    gold: autoAnalyze(signalCache.gold),
    spx:  autoAnalyze(signalCache.spx),
    updatedAt: new Date().toISOString()
  };
}

// ══════════════════════════════════════════════════════════════
//  CLAUDE CHAT
// ══════════════════════════════════════════════════════════════

function buildMarketContext() {
  const s = signalCache;
  const p = priceCache;
  return `
Current market data (${new Date().toLocaleString()}):

BTC: $${p.btc?.toLocaleString()} (${p.btcChange > 0 ? "+" : ""}${p.btcChange}% 24h)
Signal: ${s.btc?.signal} | Trend: ${s.btc?.trend} | RSI: ${s.btc?.indicators?.rsi}
${s.btc?.signal !== "WAIT" ? `Entry: $${s.btc?.entry} | Stop: $${s.btc?.stop} | Target: $${s.btc?.target}` : "No active setup"}

Gold: $${p.gold?.toLocaleString()} (${p.goldChange > 0 ? "+" : ""}${p.goldChange}% 24h)
Signal: ${s.gold?.signal} | Trend: ${s.gold?.trend} | RSI: ${s.gold?.indicators?.rsi}
${s.gold?.signal !== "WAIT" ? `Entry: $${s.gold?.entry} | Stop: $${s.gold?.stop} | Target: $${s.gold?.target}` : "No active setup"}

SPY: $${p.spx?.toLocaleString()} (${p.spxChange > 0 ? "+" : ""}${p.spxChange}% 24h)
Signal: ${s.spx?.signal} | Trend: ${s.spx?.trend} | RSI: ${s.spx?.indicators?.rsi}
`.trim();
}

async function askClaude(question) {
  const context = buildMarketContext();

  if (anthropic) {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: "You are SmartEntry Pro, a professional trading analyst. Answer concisely and practically. Always include specific levels (entry, stop, target) when discussing trades. Never give financial advice — give analysis.",
      messages: [{ role: "user", content: `Market context:\n${context}\n\nQuestion: ${question}` }]
    });
    return msg.content[0].text;
  }

  // Fallback — rule-based response without API key
  const q = question.toLowerCase();
  if (q.includes("btc") || q.includes("bitcoin")) return autoAnalyze(signalCache.btc) ?? "BTC signal not available.";
  if (q.includes("gold") || q.includes("xau"))    return autoAnalyze(signalCache.gold) ?? "Gold signal not available.";
  if (q.includes("spy") || q.includes("s&p"))     return autoAnalyze(signalCache.spx)  ?? "SPY signal not available.";
  return `Here is the current market snapshot:\n\n${context}\n\nAsk me about a specific asset (BTC, Gold, SPY) for a detailed analysis.`;
}

// ── Serve dashboard ──────────────────────────────────────────
const path = require("path");
app.use(express.static(path.join(__dirname, "..", "dashboard")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "index.html")));

// ── Boot ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ SmartEntry Pro v9 on port ${PORT}`);
  await fetchPrices();
  await refreshSignals();
  await fetchCongress();
  await fetchFlow();
  generateDailyPlan();
  setInterval(pollTelegram, 3000);
});
