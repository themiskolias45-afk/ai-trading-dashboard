/**
 * SmartEntry Pro Server v10
 * Real TA + Claude AI analysis + Ask Claude chat
 * Port: 3001
 */

const express    = require("express");
const axios      = require("axios");
const cron       = require("node-cron");
const Anthropic  = require("@anthropic-ai/sdk");
const fs         = require("fs");

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
const PORT           = process.env.PORT           || 3001;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const UW_API_KEY     = process.env.UW_API_KEY     || "";

// Load Claude API key — from apikey.txt file first, then environment variable
function loadApiKey() {
  try {
    const p = require("path").join(__dirname, "apikey.txt");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  } catch (e) {}
  return process.env.ANTHROPIC_API_KEY || "";
}
const ANTHROPIC_API_KEY = loadApiKey();

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
let mt5Positions  = [];   // reported by mt5_bridge.py via POST /api/mt5/positions
let features      = { autoCommentary: true, trailingStop: true, newsFilter: true, tradeJournal: true, positionReview: true, weeklyReport: true };
let tradeJournal  = [];   // trade journal entries (max 200)
let newsCache     = [];   // economic calendar events from ForexFactory

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

// ── Multi-timeframe wrapper ───────────────────────────────────
function generateSignalMTF(label, ticker, dailyData, h4Data) {
  const daily = generateSignal(label, ticker, dailyData.closes, dailyData.highs, dailyData.lows);
  if (!daily) return null;

  let h4 = null;
  try {
    if (h4Data?.closes?.length >= 50)
      h4 = generateSignal(label, ticker, h4Data.closes, h4Data.highs, h4Data.lows);
  } catch (e) {}

  // Confidence: rises when both timeframes agree
  let confidence = daily.signal === "WAIT" ? 0 : 40;
  if (h4 && h4.signal === daily.signal && daily.signal !== "WAIT") {
    confidence = daily.strength === "STRONG" || h4.strength === "STRONG" ? 88 : 72;
    if (daily.strength === "STRONG" && h4.strength === "STRONG") confidence = 95;
  } else if (h4 && h4.signal !== "WAIT" && daily.signal === "WAIT") {
    confidence = 25; // 4H only — weaker
  }

  // Pivots from last completed daily candle
  const n = dailyData.closes.length;
  const pivots = n >= 2 ? calcPivots(dailyData.highs[n - 2], dailyData.lows[n - 2], dailyData.closes[n - 2]) : null;

  // Require confidence ≥ 65 for a signal to fire
  const finalSignal   = confidence >= 65 ? daily.signal : "WAIT";
  const finalStrength = confidence >= 90 ? "STRONG" : confidence >= 70 ? "MODERATE" : "NONE";

  return {
    ...daily,
    signal:     finalSignal,
    strength:   finalStrength,
    confidence,
    h4: h4 ? { signal: h4.signal, trend: h4.trend, rsi: h4.indicators?.rsi } : null,
    pivots,
    session: getCurrentSession()
  };
}

// ══════════════════════════════════════════════════════════════
//  SESSION & PIVOT POINTS
// ══════════════════════════════════════════════════════════════

function getCurrentSession() {
  const h = new Date().getUTCHours();
  if (h >= 22 || h < 7)  return { name: "ASIAN",    color: "#eab308" };
  if (h >= 7  && h < 9)  return { name: "PRE-LONDON", color: "#64748b" };
  if (h >= 9  && h < 12) return { name: "LONDON",   color: "#3b82f6" };
  if (h >= 12 && h < 13) return { name: "OVERLAP",  color: "#8b5cf6" };
  if (h >= 13 && h < 17) return { name: "NEW YORK", color: "#22c55e" };
  return { name: "AFTER HOURS", color: "#64748b" };
}

function calcPivots(high, low, close) {
  const pp = (high + low + close) / 3;
  return {
    pp: parseFloat(pp.toFixed(2)),
    r1: parseFloat((2 * pp - low).toFixed(2)),
    r2: parseFloat((pp + (high - low)).toFixed(2)),
    s1: parseFloat((2 * pp - high).toFixed(2)),
    s2: parseFloat((pp - (high - low)).toFixed(2))
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

async function fetchCandles4H(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=60m&range=60d`;
  const res = await axios.get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } });
  const result = res.data?.chart?.result?.[0];
  if (!result) throw new Error("No 1H data");
  const q = result.indicators.quote[0];
  const rawC = q.close, rawH = q.high, rawL = q.low;
  const closes = [], highs = [], lows = [];
  for (let i = 3; i < rawC.length; i += 4) {
    const c4 = rawC.slice(i - 3, i + 1).filter(Boolean);
    const h4 = rawH.slice(i - 3, i + 1).filter(Boolean);
    const l4 = rawL.slice(i - 3, i + 1).filter(Boolean);
    if (!c4.length) continue;
    closes.push(c4[c4.length - 1]);
    highs.push(Math.max(...h4));
    lows.push(Math.min(...l4));
  }
  return { closes, highs, lows };
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
  console.log("[signals] Refreshing technical analysis (Daily + 4H)…");
  const assets = [
    { key: "btc",  label: "Bitcoin",    symbol: "BTC-USD" },
    { key: "gold", label: "Gold/XAUUSD", symbol: "GC=F"   },
    { key: "spx",  label: "S&P500/SPY", symbol: "SPY"     }
  ];
  for (const a of assets) {
    try {
      const [daily, h4] = await Promise.allSettled([fetchCandles(a.symbol), fetchCandles4H(a.symbol)]);
      const dailyData = daily.status === "fulfilled" ? daily.value : null;
      const h4Data    = h4.status    === "fulfilled" ? h4.value    : null;
      if (!dailyData) { console.error(`[signals] ${a.label}: no daily data`); continue; }
      signalCache[a.key] = generateSignalMTF(a.label, a.symbol, dailyData, h4Data);
      const s = signalCache[a.key];
      console.log(`[signals] ${a.label}: ${s?.signal} (${s?.strength}) | confidence: ${s?.confidence}% | 4H: ${h4Data ? s?.h4?.signal ?? "?" : "unavailable"}`);
    } catch (e) {
      console.error(`[signals] ${a.label} error:`, e.message);
    }
  }
  signalCache.updatedAt = new Date().toISOString();
  refreshAnalysis();
}

// ── Unusual Whales ────────────────────────────────────────────
async function fetchCongress() {
  if (!UW_API_KEY) return;
  try {
    const res = await axios.get(`${UW_BASE}/congress/trades`, { headers: uwHeaders, timeout: 10000, params: { limit: 20 } });
    congressCache = res.data;
  } catch (e) { console.error("UW congress:", e.message); }
}

async function fetchFlow() {
  if (!UW_API_KEY) return;
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

const SERVER_START = new Date().toISOString();
app.get("/api/status",  (_, res) => res.json({ status: "online", version: 12, startedAt: SERVER_START, session: getCurrentSession(), ...priceCache }));
app.post("/api/shutdown", (_, res) => {
  res.json({ ok: true });
  console.log("[server] Shutdown requested from dashboard");
  setTimeout(() => process.exit(0), 400);
});
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

// MT5 bridge endpoints
app.get("/api/mt5/positions",  (_, res) => res.json({ positions: mt5Positions }));
app.post("/api/mt5/positions", (req, res) => {
  mt5Positions = req.body?.positions ?? [];
  res.json({ ok: true, count: mt5Positions.length });
});

app.get("/api/analysis", (_, res) => {
  if (!analysisCache.updatedAt) refreshAnalysis();
  res.json(analysisCache);
});

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const reply = await askClaude(message);
    if (!reply) return res.json({ reply: "No reply from AI — check API key." });
    res.json({ reply, context: buildMarketContext() });
  } catch (e) {
    const msg = e?.message || e?.toString() || "Unknown error";
    console.error("[chat] error:", msg);
    res.status(500).json({ error: msg });
  }
});

// ── V12 Feature Endpoints ─────────────────────────────────────

// MT5 bridge notifies server when a trade is opened
app.post("/api/trade-opened", async (req, res) => {
  const trade = req.body;
  if (!trade || !trade.ticket) return res.status(400).json({ error: "invalid trade data" });
  console.log(`[trade] Opened: ${trade.type} ${trade.symbol} @ $${trade.price} #${trade.ticket}`);

  // Generate Claude commentary if feature enabled
  let commentary = null;
  if (features.autoCommentary) {
    commentary = await generateTradeCommentary(trade);
  }

  // Add to trade journal
  if (features.tradeJournal) {
    const entry = {
      id:        Date.now(),
      ticket:    trade.ticket,
      symbol:    trade.symbol,
      direction: trade.type,
      entry:     trade.price,
      sl:        trade.sl,
      tp:        trade.tp,
      volume:    trade.volume,
      openTime:  new Date().toISOString(),
      closeTime: null,
      closePrice: null,
      pnl:       null,
      status:    "OPEN",
      commentary
    };
    tradeJournal.unshift(entry);
    if (tradeJournal.length > 200) tradeJournal = tradeJournal.slice(0, 200);
  }

  // Post commentary to alerts panel
  if (commentary && features.autoCommentary) {
    const alert = {
      id:      Date.now(),
      ts:      new Date().toISOString(),
      ticker:  trade.symbol,
      action:  `${trade.type} OPENED`,
      price:   trade.price,
      message: commentary
    };
    tvAlerts.unshift(alert);
    if (tvAlerts.length > 50) tvAlerts = tvAlerts.slice(0, 50);
  }

  res.json({ ok: true, commentary });
});

// MT5 bridge notifies server when a trade is closed
app.post("/api/trade-closed", (req, res) => {
  const { ticket, pnl, closePrice, closeTime } = req.body;
  if (!ticket) return res.status(400).json({ error: "ticket required" });
  const trade = tradeJournal.find(t => t.ticket === ticket);
  if (trade) {
    trade.status     = "CLOSED";
    trade.pnl        = pnl       ?? null;
    trade.closePrice = closePrice ?? null;
    trade.closeTime  = closeTime  ?? new Date().toISOString();
  }
  console.log(`[trade] Closed: #${ticket}  P&L $${pnl}`);
  res.json({ ok: true });
});

// Trade journal (last 50 entries)
app.get("/api/journal", (_, res) => {
  res.json({ journal: tradeJournal.slice(0, 50) });
});

// Feature flags
app.get("/api/features", (_, res) => {
  res.json({ features });
});

app.post("/api/features/:name/toggle", (req, res) => {
  const { name } = req.params;
  if (!(name in features)) return res.status(404).json({ error: "unknown feature" });
  features[name] = !features[name];
  console.log(`[feature] ${name} → ${features[name] ? "ON" : "OFF"}`);
  res.json({ feature: name, enabled: features[name] });
});

// News blackout status (used by MT5 bridge before placing orders)
app.get("/api/newsfilter", (_, res) => {
  const status = isNewsBlackout();
  res.json({ enabled: features.newsFilter, ...status, events: newsCache.length });
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
  if (!TELEGRAM_TOKEN) return;
  for (const cid of knownChatIds) await sendTelegram(cid, planToTelegram(dailyPlan));
  console.log("[cron] 7:00 AM — plan sent");
});

// Every 4 hours — refresh signals (catches intraday setups)
cron.schedule("0 */4 * * *", async () => {
  await fetchPrices();
  await refreshSignals();
  generateDailyPlan();
  // Alert if strong signal appeared
  if (TELEGRAM_TOKEN) {
    for (const key of ["btc", "gold"]) {
      const s = signalCache[key];
      if (s && s.signal !== "WAIT" && s.strength === "STRONG") {
        for (const cid of knownChatIds) await sendTelegram(cid, `⚡ <b>STRONG SIGNAL DETECTED</b>\n\n` + signalToTelegram(s));
      }
    }
  }
});

// Every 60s — price refresh
cron.schedule("* * * * *", fetchPrices);

// Every 15 min — UW data
cron.schedule("*/15 * * * *", async () => { await fetchCongress(); await fetchFlow(); });

// Every 4 hours — Claude position review (offset 30 min from signal refresh)
cron.schedule("30 */4 * * *", async () => {
  if (features.positionReview && mt5Positions.length > 0) {
    console.log("[cron] 4H position review…");
    await reviewOpenPositions();
  }
});

// Sunday 8:00 AM — weekly performance report
cron.schedule("0 8 * * 0", async () => {
  console.log("[cron] Sunday 8AM — generating weekly report…");
  await generateWeeklyReport();
});

// Every 6 hours — refresh economic calendar
cron.schedule("0 */6 * * *", fetchEconomicCalendar);

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
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: "You are SmartEntry Pro, a professional trading analyst. Answer concisely and practically. Always include specific levels (entry, stop, target) when discussing trades. Never give financial advice — give analysis.",
      messages: [{ role: "user", content: `Market context:\n${context}\n\nQuestion: ${question}` }]
    });
    const text = msg.content?.[0]?.text;
    console.log("[chat] Claude reply length:", text?.length ?? 0);
    return text;
  }

  // Fallback — rule-based response without API key
  const q = question.toLowerCase();
  if (q.includes("btc") || q.includes("bitcoin")) return autoAnalyze(signalCache.btc) ?? "BTC signal not available.";
  if (q.includes("gold") || q.includes("xau"))    return autoAnalyze(signalCache.gold) ?? "Gold signal not available.";
  if (q.includes("spy") || q.includes("s&p"))     return autoAnalyze(signalCache.spx)  ?? "SPY signal not available.";
  return `Here is the current market snapshot:\n\n${context}\n\nAsk me about a specific asset (BTC, Gold, SPY) for a detailed analysis.`;
}

// ══════════════════════════════════════════════════════════════
//  V12 FEATURES
// ══════════════════════════════════════════════════════════════

async function fetchEconomicCalendar() {
  try {
    const res = await axios.get("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { timeout: 10000 });
    newsCache = Array.isArray(res.data) ? res.data : [];
    console.log(`[news] Calendar loaded — ${newsCache.length} events this week`);
  } catch (e) {
    console.error("[news] Calendar fetch failed:", e.message);
  }
}

function isNewsBlackout() {
  if (!features.newsFilter) return { blackout: false, reason: null };
  const now = Date.now();
  const WINDOW_MS = 30 * 60 * 1000;  // 30 minutes either side
  const relevant = newsCache.filter(ev => {
    if (!ev.impact || ev.impact.toLowerCase() !== "high") return false;
    const cur = (ev.currency ?? "").toUpperCase();
    return cur === "USD" || cur === "XAU";
  });
  for (const ev of relevant) {
    try {
      const evTime = new Date(ev.date).getTime();
      if (Math.abs(now - evTime) <= WINDOW_MS) {
        return { blackout: true, reason: `${ev.title} (${ev.currency}) @ ${new Date(evTime).toUTCString()}` };
      }
    } catch {}
  }
  return { blackout: false, reason: null };
}

async function generateTradeCommentary(trade) {
  if (!features.autoCommentary || !anthropic) return null;
  try {
    const prompt =
      `You are a professional trading analyst. A trade was just opened on MetaTrader 5. ` +
      `Write a concise 2-3 sentence analysis of this setup.\n\n` +
      `Trade: ${trade.type} ${trade.symbol}\n` +
      `Entry: $${trade.price} | Stop: $${trade.sl} | Target: $${trade.tp} | Volume: ${trade.volume} lots\n\n` +
      `Market context:\n${buildMarketContext()}\n\n` +
      `Cover: (1) why this trade makes technical sense, (2) key risk to watch, (3) target expectation. ` +
      `Be specific about price levels. No bullet points — prose only.`;

    const msg = await anthropic.messages.create({
      model:      "claude-opus-4-8",
      max_tokens: 300,
      messages:   [{ role: "user", content: prompt }]
    });
    return msg.content?.[0]?.text ?? null;
  } catch (e) {
    console.error("[commentary] Error:", e.message);
    return null;
  }
}

async function reviewOpenPositions() {
  if (!features.positionReview || !anthropic || mt5Positions.length === 0) return;
  try {
    const positionList = mt5Positions.map(p =>
      `${p.type} ${p.symbol}: Entry $${p.price}, SL $${p.sl}, TP $${p.tp}, ` +
      `P&L ${p.profit >= 0 ? "+" : ""}$${p.profit}, ${p.volume} lots (opened ${p.openTime})`
    ).join("\n");

    const prompt =
      `You are a professional trading coach reviewing open MT5 positions.\n\n` +
      `Open Positions (${mt5Positions.length}):\n${positionList}\n\n` +
      `Market context:\n${buildMarketContext()}\n\n` +
      `For each position: (1) is it progressing as expected? (2) should the stop be adjusted? ` +
      `(3) any exit consideration? End with an overall portfolio risk assessment. Keep it concise and actionable.`;

    const msg = await anthropic.messages.create({
      model:      "claude-opus-4-8",
      max_tokens: 600,
      messages:   [{ role: "user", content: prompt }]
    });
    const review = msg.content?.[0]?.text;
    if (review) {
      tvAlerts.unshift({ id: Date.now(), ts: new Date().toISOString(), ticker: "PORTFOLIO", action: "POSITION REVIEW", price: null, message: review });
      if (tvAlerts.length > 50) tvAlerts = tvAlerts.slice(0, 50);
      console.log("[review] Position review posted to alerts");
    }
  } catch (e) {
    console.error("[review] Error:", e.message);
  }
}

async function generateWeeklyReport() {
  if (!features.weeklyReport || !anthropic) return;
  try {
    const wins      = tradeJournal.filter(t => (t.pnl ?? 0) > 0);
    const losses    = tradeJournal.filter(t => (t.pnl ?? 0) < 0);
    const totalPnl  = tradeJournal.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate   = tradeJournal.length > 0 ? ((wins.length / tradeJournal.length) * 100).toFixed(1) : "N/A";
    const recentTrades = tradeJournal.slice(0, 20).map(t =>
      `${t.direction} ${t.symbol}: Entry $${t.entry}, P&L ${t.pnl != null ? "$" + t.pnl.toFixed(2) : "(open)"}${t.status === "OPEN" ? " [OPEN]" : ""}`
    ).join("\n");

    const prompt =
      `You are a professional trading coach writing a weekly performance review.\n\n` +
      `Performance Summary:\n` +
      `- Total Trades: ${tradeJournal.length} | Wins: ${wins.length} | Losses: ${losses.length}\n` +
      `- Win Rate: ${winRate}% | Total P&L: $${totalPnl.toFixed(2)}\n\n` +
      `Recent Trades:\n${recentTrades || "No trades recorded this week."}\n\n` +
      `Market context:\n${buildMarketContext()}\n\n` +
      `Provide: (1) performance summary, (2) what worked well, (3) key improvement areas, ` +
      `(4) strategy suggestions for next week. Practical and concise.`;

    const msg = await anthropic.messages.create({
      model:      "claude-opus-4-8",
      max_tokens: 800,
      messages:   [{ role: "user", content: prompt }]
    });
    const report = msg.content?.[0]?.text;
    if (report) {
      tvAlerts.unshift({ id: Date.now(), ts: new Date().toISOString(), ticker: "WEEKLY", action: "WEEKLY REPORT", price: null, message: report });
      if (tvAlerts.length > 50) tvAlerts = tvAlerts.slice(0, 50);
      console.log("[weekly] Weekly report posted to alerts");
    }
  } catch (e) {
    console.error("[weekly] Error:", e.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  BACKTESTING ENGINE
// ══════════════════════════════════════════════════════════════

let backtestCache = {};   // { btc: result, gold: result, spx: result, runAt: iso }

async function runBacktest(symbol, label, years = 5) {
  const range = `${years * 365}d`;
  const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const res   = await axios.get(url, { timeout: 30000, headers: { "User-Agent": "Mozilla/5.0" } });
  const result = res.data?.chart?.result?.[0];
  if (!result) throw new Error("No historical data");

  const q   = result.indicators.quote[0];
  const tss = result.timestamp;
  const bars = [];
  for (let i = 0; i < tss.length; i++) {
    if (q.close[i] != null && q.high[i] != null && q.low[i] != null)
      bars.push({ ts: tss[i], close: q.close[i], high: q.high[i], low: q.low[i] });
  }

  const trades = [];
  let lastKey  = null;
  const MIN    = 210;  // warm-up for EMA200

  for (let i = MIN; i < bars.length; i++) {
    const w = bars.slice(0, i + 1);
    const sig = generateSignal(label, symbol,
      w.map(b => b.close), w.map(b => b.high), w.map(b => b.low));
    if (!sig || sig.signal === "WAIT" || !sig.stop || !sig.target) { lastKey = null; continue; }

    const key = `${sig.signal}_${sig.setup}_${i}`;
    if (key === lastKey) continue;
    lastKey = key;

    const { signal, entry, stop: sl, target: tp } = sig;
    const rr = parseFloat((Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(1));

    let outcome = "EXPIRED", barsHeld = 0;
    for (let j = i + 1; j < bars.length && j <= i + 60; j++) {
      const b = bars[j];
      barsHeld++;
      if (signal === "BUY") {
        if (b.low  <= sl) { outcome = "LOSS"; break; }
        if (b.high >= tp) { outcome = "WIN";  break; }
      } else {
        if (b.high >= sl) { outcome = "LOSS"; break; }
        if (b.low  <= tp) { outcome = "WIN";  break; }
      }
    }

    trades.push({
      date:     new Date(bars[i].ts * 1000).toISOString().split("T")[0],
      signal, setup: sig.setup,
      entry:    parseFloat(entry.toFixed(2)),
      sl:       parseFloat(sl.toFixed(2)),
      tp:       parseFloat(tp.toFixed(2)),
      rr, outcome, barsHeld
    });
  }

  const wins   = trades.filter(t => t.outcome === "WIN").length;
  const losses = trades.filter(t => t.outcome === "LOSS").length;
  const closed = wins + losses;
  const winRate = closed > 0 ? parseFloat((wins / closed * 100).toFixed(1)) : 0;

  // Equity curve — 1% risk per trade on $10 000 start
  let equity = 10000, peak = 10000, maxDD = 0;
  const curve = [10000];
  for (const t of trades) {
    if (t.outcome === "WIN")  equity *= (1 + 0.01 * t.rr);
    if (t.outcome === "LOSS") equity *= 0.99;
    curve.push(parseFloat(equity.toFixed(0)));
    peak  = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak * 100);
  }

  const winRRsum  = trades.filter(t => t.outcome === "WIN").reduce((s, t) => s + t.rr, 0);
  const profitFactor = losses > 0 ? parseFloat((winRRsum / losses).toFixed(2)) : null;

  return {
    symbol, label, years,
    totalTrades: trades.length, wins, losses, winRate,
    avgRR:        parseFloat((trades.reduce((s, t) => s + t.rr, 0) / (trades.length || 1)).toFixed(1)),
    profitFactor,
    startEquity:  10000,
    finalEquity:  parseFloat(equity.toFixed(0)),
    returnPct:    parseFloat(((equity - 10000) / 100).toFixed(1)),
    maxDrawdown:  parseFloat(maxDD.toFixed(1)),
    expectancy:   parseFloat(((winRate / 100 * (trades.reduce((s,t)=>s+t.rr,0)/(trades.length||1))) - (1 - winRate / 100)).toFixed(2)),
    curve:        curve.slice(-120),
    recentTrades: trades.slice(-15)
  };
}

app.get("/api/backtest", async (req, res) => {
  const years = Math.min(parseInt(req.query.years ?? "5"), 10);
  const force = req.query.force === "1";

  // Use cache if < 12 hours old and same years
  if (!force && backtestCache.runAt && backtestCache.years === years) {
    const age = Date.now() - new Date(backtestCache.runAt).getTime();
    if (age < 12 * 3600 * 1000) return res.json(backtestCache);
  }

  console.log(`[backtest] Running ${years}-year backtest on BTC, Gold, SPY…`);
  const assets = [
    { key: "btc",  label: "Bitcoin",    symbol: "BTC-USD" },
    { key: "gold", label: "Gold/XAUUSD", symbol: "GC=F"   },
    { key: "spx",  label: "S&P500/SPY", symbol: "SPY"     }
  ];
  const out = { years, runAt: new Date().toISOString() };
  for (const a of assets) {
    try {
      out[a.key] = await runBacktest(a.symbol, a.label, years);
      console.log(`[backtest] ${a.label}: ${out[a.key].totalTrades} trades | WR ${out[a.key].winRate}% | Return ${out[a.key].returnPct}%`);
    } catch (e) {
      console.error(`[backtest] ${a.label} error:`, e.message);
      out[a.key] = { error: e.message };
    }
  }

  // Ask Claude to summarize the results
  if (anthropic) {
    try {
      const summary = [out.btc, out.gold, out.spx].filter(r => !r?.error).map(r =>
        `${r.label}: ${r.totalTrades} trades over ${years}y | Win rate ${r.winRate}% | Profit factor ${r.profitFactor} | Max drawdown ${r.maxDrawdown}% | Return on $10k: $${r.finalEquity} (${r.returnPct}%)`
      ).join("\n");

      const msg = await anthropic.messages.create({
        model: "claude-opus-4-8", max_tokens: 500,
        messages: [{ role: "user", content:
          `You are a professional quant analyst. Here are backtesting results for a rule-based trading strategy over ${years} years:\n\n${summary}\n\n` +
          `In 4-5 concise sentences: (1) is this strategy viable? (2) which asset performs best? (3) biggest risk/weakness? (4) one concrete improvement suggestion.`
        }]
      });
      out.claudeVerdict = msg.content?.[0]?.text ?? null;
    } catch {}
  }

  backtestCache = out;
  res.json(out);
});

// ── Serve dashboard ──────────────────────────────────────────
const path = require("path");
app.use(express.static(path.join(__dirname, "..", "dashboard")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "index.html")));

// ── Boot ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ SmartEntry Pro v12 on port ${PORT}`);
  await fetchPrices();
  await refreshSignals();
  await fetchCongress();
  await fetchFlow();
  await fetchEconomicCalendar();
  generateDailyPlan();
  if (TELEGRAM_TOKEN) setInterval(pollTelegram, 3000);
  if (ANTHROPIC_API_KEY) console.log("[ai] Claude AI enabled ✅");
  else console.log("[ai] No ANTHROPIC_API_KEY — using rule-based analysis");
});
