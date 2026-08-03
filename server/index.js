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
const path       = require("path");
const { YouTube } = require("youtube-sr");

// ── New modules ───────────────────────────────────────────────
const autohealer = require("./autohealer");
const db         = require("./db");
const sizing     = require("./sizing");
const hermes     = require("./hermes");

const app = express();

// Express defaults to a 100kb JSON body, which every endpoint here fits inside
// except one: /api/mt5/candles carries 1100 bars x 4 series x 3 symbols and
// measured ~240kb, so the bridge's very first push came back 413 Payload Too
// Large and the server silently stayed on its Yahoo fallback. Raised only as far
// as that payload needs — the bridge additionally rounds its values to keep it
// well under this, and the candles route is requireLocalOnly, so this does not
// widen what an internet-facing VPS will accept from an unauthenticated caller.
const JSON_BODY_LIMIT = "2mb";
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Dashboard login — protects the human-facing pages only ─────
// Never gates /api/* here: the MT5 bridge, TradingView webhooks, and the cloud
// research/health-check agents all call dozens of API routes with no browser
// session, and a blanket gate would break every one of them. The handful of
// truly dangerous mutating endpoints already have their own requireLocalOnly
// guard (added earlier); this is specifically "don't let a stranger view the
// dashboard," which is a page-level concern, not an API-level one.
const crypto = require("crypto");
const DASHBOARD_USERNAME = (process.env.DASHBOARD_USERNAME || "").trim();
const DASHBOARD_PASSWORD = (process.env.DASHBOARD_PASSWORD || "").trim();
// Session secret, persisted across restarts.
//
// This used to be regenerated on every boot, which sounds safe and reads as
// "everyone re-logs in, by design" — but the watchdog restarts this server on any
// crash, and every deploy restarts it too. In practice it meant being logged out
// at random, repeatedly, including in the middle of trying to look at a live
// position. A 30-day cookie that silently dies on an unrelated crash is not a
// security control, it is a papercut that trains you to distrust the dashboard.
//
// Now generated once and kept in a file next to the other secrets (gitignored,
// same trust boundary as apikey.txt). Delete the file to invalidate every session.
const SESSION_SECRET_PATH = path.join(__dirname, "session_secret.txt");

function loadOrCreateSessionSecret() {
  try {
    if (fs.existsSync(SESSION_SECRET_PATH)) {
      const existing = fs.readFileSync(SESSION_SECRET_PATH, "utf8").trim();
      // A truncated or empty file must not become a guessable secret.
      if (existing.length >= 32) return existing;
      console.warn("[auth] session_secret.txt too short — regenerating");
    }
  } catch (e) {
    console.error(`[auth] Could not read session secret (${e.message}) — regenerating`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(SESSION_SECRET_PATH, generated, { mode: 0o600 });
  } catch (e) {
    // Falling back to memory-only keeps the server usable; it just means the old
    // log-out-on-restart behaviour for this run.
    console.error(`[auth] Could not persist session secret (${e.message}) — sessions will not survive a restart`);
  }
  return generated;
}

const SESSION_SECRET = loadOrCreateSessionSecret();
const SESSION_COOKIE = "smartentry_session";

function timingSafeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

app.get("/login", (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "login.html")));

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: "Dashboard login is not configured on the server." });
  }
  const userOk = typeof username === "string" && timingSafeStringEqual(username, DASHBOARD_USERNAME);
  const passOk = typeof password === "string" && timingSafeStringEqual(password, DASHBOARD_PASSWORD);
  if (!userOk || !passOk) return res.status(401).json({ error: "Invalid username or password." });

  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${SESSION_SECRET}; HttpOnly; SameSite=Lax; Max-Age=2592000; Path=/`);
  res.json({ ok: true });
});

app.post("/api/logout", (_, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
  res.json({ ok: true });
});

// Exact set of API routes real machine callers need with no browser session:
// the MT5 bridge (positions/risk/trade lifecycle/signal polling/trade approval),
// the TradingView webhook, and the cloud research/health agents (already gated
// separately by AGENT_RELAY_SECRET, or read-only status/journal/backtest data).
// Everything else under /api/* is human-facing and now requires being logged in —
// /api/chat in particular has tool access (force_heal, approve_proposal) and spends
// real Anthropic/Brave API credits, and had no auth at all before this.
const API_NO_LOGIN_REQUIRED = new Set([
  "/api/login", "/api/logout",
  "/api/signals", "/api/newsfilter", "/api/features",
  "/api/mt5/positions", "/api/risk-status",
  "/api/trade-opened", "/api/trade-closed",
  "/api/tv-alert", "/api/claude-approve-trade",
  "/api/agent/notify", "/api/mt5/health", "/api/status",
  "/api/checksystem", "/api/journal", "/api/backtest", "/api/learning",
  "/api/healer", "/api/healer/heal",
  // The bridge must call this before every trade and has no browser session.
  // Pure calculation: it validates and sizes a hypothetical trade and mutates
  // nothing, so exposing it grants no power over the account.
  "/api/size",
  // Session-free because the bridge has no browser, but the POST additionally
  // carries requireLocalOnly — unlike the other bridge endpoints, which only
  // REPORT state, this one FEEDS the signal engine. An unauthenticated writer
  // could push fabricated bars and manufacture a high-confidence signal that
  // every auto-mode bridge would then execute. Reachable from the internet on
  // the VPS, so the localhost restriction is the control that matters here; the
  // bridge always runs on the same machine as the server.
  "/api/mt5/candles",
]);

// Paths the MT5 bridge must READ without a browser session, but which must never
// be WRITABLE without one. /api/mt5/control is the remote kill switch: an
// unauthenticated POST there could RESUME trading after a safety halt, and this
// server is reachable from the internet on the VPS. Read freely, write only when
// logged in.
const API_NO_LOGIN_GET_ONLY = new Set([
  "/api/mt5/control",
  "/api/strategy-settings",
]);

app.use((req, res, next) => {
  if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) return next(); // not configured yet — never lock the owner out
  if (req.path === "/login") return next();
  if (req.method === "GET" && API_NO_LOGIN_GET_ONLY.has(req.path)) return next();
  if (req.path.startsWith("/api/") && !API_NO_LOGIN_REQUIRED.has(req.path)) {
    const cookies = parseCookies(req);
    if (cookies[SESSION_COOKIE] && timingSafeStringEqual(cookies[SESSION_COOKIE], SESSION_SECRET)) return next();
    return res.status(401).json({ error: "Not logged in." });
  }
  if (req.path.startsWith("/api/")) return next(); // in the no-login allowlist above

  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE] && timingSafeStringEqual(cookies[SESSION_COOKIE], SESSION_SECRET)) return next();
  return res.redirect("/login");
});

// ── Config ────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3001;
const KEYS_ENV_PATH  = path.join(__dirname, "..", "keys.env");
const APIKEY_PATH    = path.join(__dirname, "apikey.txt");

let TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || "";
let TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
let UW_API_KEY       = process.env.UW_API_KEY       || "";
let OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || "";

// Load Claude API key — from apikey.txt file first, then environment variable
function loadApiKey() {
  try {
    if (fs.existsSync(APIKEY_PATH)) return fs.readFileSync(APIKEY_PATH, "utf8").trim();
  } catch (e) {}
  return process.env.ANTHROPIC_API_KEY || "";
}
let ANTHROPIC_API_KEY = loadApiKey();
let anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
function reloadAnthropicClient() {
  ANTHROPIC_API_KEY = loadApiKey();
  anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
  console.log(ANTHROPIC_API_KEY ? "[settings] Anthropic key reloaded" : "[settings] Anthropic key cleared");
}
const UW_BASE        = "https://api.unusualwhales.com/api";
function getUwHeaders() {
  return { Authorization: `Bearer ${UW_API_KEY}`, Accept: "application/json", "User-Agent": "SmartEntry/9.0" };
}

// ── Settings persistence (keys.env — gitignored, never committed) ──────
function sanitizeEnvValue(v) { return String(v).replace(/[\r\n]/g, " ").trim(); }
function readKeysEnv() {
  const map = {};
  try {
    if (fs.existsSync(KEYS_ENV_PATH)) {
      for (const line of fs.readFileSync(KEYS_ENV_PATH, "utf8").split(/\r?\n/)) {
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        if (k) map[k] = line.slice(idx + 1).trim();
      }
    }
  } catch (e) { console.error("[settings] keys.env read error:", e.message); }
  return map;
}
function writeKeysEnv(updates) {
  const map = readKeysEnv();
  for (const [k, v] of Object.entries(updates)) map[k] = sanitizeEnvValue(v);
  const body = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\r\n") + "\r\n";
  fs.writeFileSync(KEYS_ENV_PATH, body, "utf8");
}
function maskKey(v) {
  if (!v) return null;
  return v.length <= 8 ? "••••" : v.slice(0, 4) + "…" + v.slice(-4);
}

// ── State ─────────────────────────────────────────────────────
let priceCache    = { btc: null, btcChange: null, gold: null, goldChange: null, spx: null, spxChange: null, dxy: null, dxyChange: null, vix: null, updated: null };
let sentimentCache = { fearGreed: 50, classification: "Neutral", btcSentiment: "NEUTRAL", newsHeadlines: [], updated: null };
let signalCache   = { btc: null, gold: null, spx: null, updatedAt: null };
let signalHistory = [];   // last 100 signal cycles — full confidence + reasons per asset

// Native bars pushed up from mt5_bridge.py, keyed by asset key (btc/gold/spx):
//   { symbol, bars: { d1: {closes,highs,lows,volumes}, h4: {...}, h1: {...} }, receivedAt }
// The bridge is the only process that can see MT5, so this is the only route by
// which the signal engine can read the instrument it actually trades. Preferred
// over Yahoo when fresh and deep enough; see pickCandleSource().
let mt5CandleCache = {};

// Guards the candle-ingest recompute against overlapping with itself. Three assets
// arrive in one payload and a refresh takes ~15s; without this, a bridge restart
// could stack refreshes on top of each other.
let signalRefreshInFlight = false;

// Yahoo tickers the signal engine is written against → asset keys used everywhere
// else. Declared once so the ingest endpoint and refreshSignals agree; a mismatch
// here would silently route XAUUSD bars into the BTC signal.
const ASSET_KEY_BY_TICKER = { "BTC-USD": "btc", "GC=F": "gold", "^GSPC": "spx" };

// A daily series shorter than this leaves ema200 null, which pins `trend` to
// "MIXED" and makes MOMENTUM, BREAKOUT and TREND_FOLLOW unreachable — the exact
// starvation that DAILY_RANGE_BY_SYMBOL exists to work around on the Yahoo path.
// Rather than repeat that bug with a new data source, short MT5 series are refused
// and the asset falls back to Yahoo.
const MT5_MIN_BARS = { d1: 200, h4: 50, h1: 50 };

// Past this age the bridge is assumed down or wedged and Yahoo takes over. Signals
// refresh far more often than this, so a healthy bridge never comes close.
const MT5_CANDLE_MAX_AGE_MS = 15 * 60 * 1000;
let dailyPlan     = null;
let tvAlerts      = [];
let congressCache = null;
let flowCache     = null;
let knownChatIds  = new Set();
if (TELEGRAM_CHAT_ID) knownChatIds.add(TELEGRAM_CHAT_ID);
let mt5PositionsByAccount = {};  // account tag -> positions[], one entry per connected MT5 bridge
let mt5Positions  = [];   // flattened across all accounts (each position tagged with .account) — kept for existing consumers
let features      = { autoCommentary: true, trailingStop: true, newsFilter: true, tradeJournal: true, positionReview: true, weeklyReport: true };
let tradeJournal  = [];   // trade journal entries (max 200)

// Both files below hold data that cannot be reconstructed from anything else:
// journal.json is the trade record, learning.json is weeks of accumulated edge.
// A plain writeFileSync truncates the target before it writes, so a crash or a
// full disk mid-write leaves a half-file where the history used to be. Write a
// sibling temp file and rename it into place instead — the rename is atomic, so
// the old file survives intact if anything goes wrong.
function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

// ── Persistent journal ────────────────────────────────────────
const JOURNAL_FILE = require("path").join(__dirname, "journal.json");
function loadJournal() {
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8"));
      if (Array.isArray(data)) { tradeJournal = data; console.log(`[journal] Loaded ${tradeJournal.length} entries from disk`); }
    }
  } catch (e) { console.error("[journal] Load error:", e.message); }
}
function saveJournal() {
  try { writeJsonAtomic(JOURNAL_FILE, tradeJournal); }
  catch (e) { console.error(`[journal] SAVE FAILED — ${tradeJournal.length} entries are in memory only and will be lost on restart:`, e.message); }
}
loadJournal();

// ── Self-learning engine ──────────────────────────────────────
const LEARNING_FILE = require("path").join(__dirname, "learning.json");
let learning = { setupStats: {}, sessionCount: 0, updatedAt: null };

function loadLearning() {
  try {
    if (fs.existsSync(LEARNING_FILE)) {
      learning = { ...learning, ...JSON.parse(fs.readFileSync(LEARNING_FILE, "utf8")) };
      console.log(`[learning] Loaded — ${Object.keys(learning.setupStats).length} setups tracked`);
    }
  } catch (e) { console.error("[learning] Load error:", e.message); }
}
function saveLearning() {
  learning.updatedAt = new Date().toISOString();
  // Never silent. This used to be `catch (e) {}`, so a locked or unwritable
  // learning.json discarded every recorded outcome with nothing in the log to
  // show for it — the one failure mode that costs real edge rather than uptime.
  try { writeJsonAtomic(LEARNING_FILE, learning); }
  catch (e) { console.error("[learning] SAVE FAILED — this outcome was NOT recorded and the edge it carried is lost:", e.message); }
}
function updateLearning(setup, pnl) {
  if (!setup || pnl === null || pnl === undefined) return;
  if (!learning.setupStats[setup]) learning.setupStats[setup] = { wins: 0, losses: 0, totalPnl: 0 };
  const s = learning.setupStats[setup];
  if (pnl > 0) s.wins++; else s.losses++;
  s.totalPnl = parseFloat(((s.totalPnl ?? 0) + pnl).toFixed(2));
  saveLearning();
  console.log(`[learning] ${setup} updated — W:${s.wins} L:${s.losses} (boost: ${getLearningBoost(setup)})`);
}
function getLearningBoost(setup) {
  if (!setup || !learning.setupStats[setup]) return 0;
  const s = learning.setupStats[setup];
  const total = s.wins + s.losses;
  if (total < 5) return 0;  // need minimum 5 trades before adjusting
  const wr = s.wins / total;
  // WR > 60% → positive boost up to +15, WR < 40% → negative down to -15
  const boost = Math.round((wr - 0.5) * 30);
  return Math.max(-15, Math.min(15, boost));
}

function checkSetupHealth() {
  const alerts = [];
  const AVOID_THRESHOLD    = 0.40;  // below 40% WR → avoid
  const PRIORITY_THRESHOLD = 0.65;  // above 65% WR → prioritise
  for (const [setup, s] of Object.entries(learning.setupStats)) {
    const total = s.wins + s.losses;
    if (total < 5) continue;
    const wr = s.wins / total;
    if (wr < AVOID_THRESHOLD)    alerts.push({ setup, wr: Math.round(wr * 100), status: 'AVOID',    trades: total });
    else if (wr > PRIORITY_THRESHOLD) alerts.push({ setup, wr: Math.round(wr * 100), status: 'PRIORITY', trades: total });
  }
  if (alerts.length > 0) {
    for (const a of alerts) {
      const emoji = a.status === 'AVOID' ? '⚠️' : '✅';
      console.log(`[learning] ${emoji} Setup ${a.status}: ${a.setup} ${a.wr}% WR (${a.trades} trades)`);
    }
  }
  return alerts;
}
loadLearning();
learning.sessionCount = (learning.sessionCount || 0) + 1;
saveLearning();

let newsCache     = [];   // economic calendar events from ForexFactory
let riskStatus    = { dailyPnl: 0, consecutiveLosses: 0, halted: false, haltReason: "" };

// ── Strategy settings ─────────────────────────────────────────
// The knobs that decide how much this system is allowed to do. Two of these
// never existed at all: nothing limited how many positions could be open at once,
// so BTC, Gold and SPX could all open together as one correlated bet, and nothing
// capped trades per day, so a choppy session could churn the account.
//
// The confidence gate was worse than missing — it was the literal 65 written into
// three separate places in this file. Changing your mind about it meant editing
// source in three spots and hoping you found them all, which is exactly the
// "no magic numbers" rule this project sets for itself.
//
// Persisted so a restart keeps your choices, and clamped to sane ranges so a
// fat-fingered value cannot disable the protection it is meant to tune.
const STRATEGY_SETTINGS_FILE = path.join(__dirname, "strategy_settings.json");

const STRATEGY_LIMITS = {
  // 70, not 65. Measured 2026-08-01 on a repaired 5-fold walk-forward replay
  // (tasks/mtf_walkforward.cjs, cost 0.05R): 70 is the only gate positive in 5 of
  // 5 sequential out-of-sample folds AND with TEST expectancy above TRAIN. 75 is a
  // train artifact (+0.358 TRAIN -> +0.054 TEST) and 80/85 go negative out of
  // sample; 65 is positive but thinner and fails at least one fold. An earlier
  // "edge lives above 75" conclusion is superseded - it was measured on the
  // harness that silently dropped 18% of Gold's history, repaired in b55b5f5.
  confidenceThreshold:    { min: 50, max: 95, def: 70 },
  maxConcurrentPositions: { min: 1,  max: 10, def: 3  },
  maxTradesPerDay:        { min: 1,  max: 50, def: 5  },
  // Lot controls. `decimals` matters: rounding these to whole numbers would turn
  // 0.01 into 0 and silently disable the setting the moment it was saved.
  // fixedLotSize 0 means "off — size from risk". Any value above 0 overrides the
  // risk calculation entirely and trades exactly that size.
  fixedLotSize: { min: 0,    max: 100, def: 0,  decimals: 2 },
  maxLotSize:   { min: 0.01, max: 100, def: 10, decimals: 2 },
  // Below this ADX the trend is treated as too weak to size up. Measured on this
  // account's own 5 years: >=20 lifted swing-pullback win rate 52%->65% on Gold
  // and 42%->54% on SPX.
  adxTrendingMin: { min: 10, max: 40, def: 20 },
};

// Minimum signal strength AUTO mode will trade.
//
// This was hardcoded to STRONG in mt5_bridge.py, and it is the reason the
// self-learning engine has never had anything to learn from. Learning needs 5
// closed trades PER SETUP before it adjusts anything (getLearningBoost), and 10
// before Kelly sizing engages — roughly 60 trades across the ~12 setups. STRONG-only
// produces about one trade a month, so that threshold is years away and
// setupStats has sat empty through 42 server sessions.
//
// On a demo account the scarce resource is data, not capital. Allowing MODERATE
// raises the rate to roughly one signal every 2.4 days, which fills the learning
// tables in weeks instead of years. Backtests say MODERATE trades are worse — that
// is exactly the thing the learning engine exists to measure, and it cannot
// measure a trade that was never taken.
const STRENGTH_LEVELS = ["MODERATE", "STRONG"];

let strategySettings = {
  confidenceThreshold:    STRATEGY_LIMITS.confidenceThreshold.def,
  maxConcurrentPositions: STRATEGY_LIMITS.maxConcurrentPositions.def,
  maxTradesPerDay:        STRATEGY_LIMITS.maxTradesPerDay.def,
  fixedLotSize:           STRATEGY_LIMITS.fixedLotSize.def,
  maxLotSize:             STRATEGY_LIMITS.maxLotSize.def,
  adxTrendingMin:         STRATEGY_LIMITS.adxTrendingMin.def,
  minStrength:            "MODERATE",
  updatedAt: null,
  updatedBy: null,
};

function clampStrategyValue(name, value) {
  const limit = STRATEGY_LIMITS[name];
  if (!limit) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const bounded = Math.min(limit.max, Math.max(limit.min, num));
  // Lot sizes are fractional. Rounding them like the integer settings would turn
  // a 0.01 lot into 0 and quietly switch the feature off.
  if (limit.decimals) {
    const factor = Math.pow(10, limit.decimals);
    return Math.round(bounded * factor) / factor;
  }
  return Math.round(bounded);
}

// Set when the settings file exists but could not be read, so the dashboard and
// /api/healer can say so instead of the operator discovering it from lot sizes.
let strategySettingsError = null;

function loadStrategySettings() {
  try {
    if (!fs.existsSync(STRATEGY_SETTINGS_FILE)) return;
    // A UTF-8 BOM makes JSON.parse throw on the very first character, and the catch
    // below then keeps DEFAULTS - which silently changed live sizing on the VPS on
    // 2026-08-02: fixedLotSize 0.01 became 0, i.e. full risk-based sizing on a live
    // account, from nothing louder than one log line. PowerShell's Set-Content
    // -Encoding utf8 writes that BOM by default on 5.1, so any operator edit through
    // PowerShell produces it. Stripped rather than rejected: the bytes after it are
    // valid JSON and refusing them helps nobody.
    const rawSettings = fs.readFileSync(STRATEGY_SETTINGS_FILE, "utf8").replace(/^﻿/, "");
    const saved = JSON.parse(rawSettings);
    for (const name of Object.keys(STRATEGY_LIMITS)) {
      const clamped = clampStrategyValue(name, saved[name]);
      if (clamped !== null) strategySettings[name] = clamped;
    }
    if (STRENGTH_LEVELS.includes(saved.minStrength)) strategySettings.minStrength = saved.minStrength;
    strategySettings.updatedAt = saved.updatedAt || null;
    strategySettings.updatedBy = saved.updatedBy || null;
    strategySettingsError = null;
    console.log(`[strategy] Loaded: confidence>=${strategySettings.confidenceThreshold}%, max ${strategySettings.maxConcurrentPositions} positions, max ${strategySettings.maxTradesPerDay} trades/day`);
  } catch (e) {
    // Keep the safe defaults rather than trading on a half-parsed config — but say
    // so loudly. "Safe" defaults are not the operator's settings: fixedLotSize
    // defaults to 0, which means size from risk, which is a far larger position
    // than the 0.01 a machine configured for micro lots expects.
    strategySettingsError = e.message;
    console.error(`[strategy] SETTINGS UNREADABLE (${e.message}) — RUNNING ON DEFAULTS, ` +
      `not your saved config. Live sizing and the confidence gate are the built-in ` +
      `values, not ${path.basename(STRATEGY_SETTINGS_FILE)}. Fix the file and restart.`);
  }
}

function saveStrategySettings() {
  try {
    fs.writeFileSync(STRATEGY_SETTINGS_FILE, JSON.stringify(strategySettings, null, 2));
  } catch (e) {
    console.error(`[strategy] Could not persist settings: ${e.message}`);
  }
}

loadStrategySettings();

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

// Wilder's smoothing — ADX and its components are defined on this, not on a
// simple or exponential average. Using the wrong average shifts the values enough
// to move a 25-threshold decision.
function wilderSmooth(values, period) {
  if (!values.length) return [];
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push((out[i - 1] * (period - 1) + values[i]) / period);
  }
  return out;
}

// ── ADX — trend strength ──────────────────────────────────────
// Measured on this system's own 5 years of data (2026-07-26): requiring ADX >= 20
// lifted the swing-pullback win rate from 52.2% to 64.7% on Gold and 41.7% to
// 53.8% on SPX. It answers the one question none of the other indicators do —
// whether there is a trend at all, or just chop that will stop you out.
// Returns { adx, plusDI, minusDI } or null when there is not enough history.
function calcADX(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period * 2 + 1) return null;

  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < closes.length; i++) {
    const upMove   = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }

  const trSmooth    = wilderSmooth(trs, period);
  const plusSmooth  = wilderSmooth(plusDMs, period);
  const minusSmooth = wilderSmooth(minusDMs, period);

  const dxs = [];
  for (let i = 0; i < trSmooth.length; i++) {
    if (trSmooth[i] === 0) { dxs.push(0); continue; }
    const plusDI  = 100 * plusSmooth[i]  / trSmooth[i];
    const minusDI = 100 * minusSmooth[i] / trSmooth[i];
    const sum = plusDI + minusDI;
    dxs.push(sum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sum);
  }

  const adxSeries = wilderSmooth(dxs, period);
  const lastTr    = trSmooth.at(-1);
  return {
    adx:     parseFloat(adxSeries.at(-1).toFixed(1)),
    plusDI:  lastTr ? parseFloat((100 * plusSmooth.at(-1)  / lastTr).toFixed(1)) : null,
    minusDI: lastTr ? parseFloat((100 * minusSmooth.at(-1) / lastTr).toFixed(1)) : null,
  };
}

// ── Swing structure ───────────────────────────────────────────
// A confirmed swing low needs `lookback` lower lows either side, so it is only
// known `lookback` bars after the fact — that lag is inherent, not a bug.
//
// Stops belong here rather than at a fixed ATR multiple: a structural stop sits
// where the trade thesis is actually wrong, and in testing it produced 3-4%
// drawdowns against 12%+ for the 1.5x ATR stops the engine uses today.
function findSwingLow(lows, lookback = 3) {
  for (let i = lows.length - 1 - lookback; i >= lookback; i--) {
    let isSwing = true;
    for (let j = 1; j <= lookback; j++) {
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) { isSwing = false; break; }
    }
    if (isSwing) return { price: lows[i], barsAgo: lows.length - 1 - i };
  }
  return null;
}

function findSwingHigh(highs, lookback = 3) {
  for (let i = highs.length - 1 - lookback; i >= lookback; i--) {
    let isSwing = true;
    for (let j = 1; j <= lookback; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) { isSwing = false; break; }
    }
    if (isSwing) return { price: highs[i], barsAgo: highs.length - 1 - i };
  }
  return null;
}

// ── Core signal generator ─────────────────────────────────────
function generateSignal(label, ticker, closes, highs, lows, volumes = [], dxyCloses = null) {
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

  const inUptrend   = trend === "STRONG UPTREND" || trend === "UPTREND";
  const inDowntrend = trend === "STRONG DOWNTREND" || trend === "DOWNTREND";

  // Volume analysis
  const avgVol = volumes.length >= 20
    ? volumes.slice(-20).reduce((a,b) => a+b, 0) / 20
    : null;
  const lastVol  = volumes[volumes.length - 1] ?? 0;
  const volRatio = avgVol && avgVol > 0 ? parseFloat((lastVol / avgVol).toFixed(1)) : null;
  const volConfirmed = volRatio !== null && volRatio >= 1.4;

  // ATR-based stop distances
  const atrStop1x = atrVal ?? null;
  const atrStop15 = atrVal ? atrVal * 1.5 : null;
  const atrStop2x = atrVal ? atrVal * 2.0 : null;

  // Trend strength and market structure.
  const adxData    = calcADX(highs, lows, closes);
  const adxValue   = adxData ? adxData.adx : null;
  const swingLow   = findSwingLow(lows);
  const swingHigh  = findSwingHigh(highs);

  // ADX below this is chop: price moves, but not in a way a trend-following
  // setup survives. Measured on 5 years of this system's own assets — requiring
  // >= 20 lifted win rate 52%->65% on Gold and 42%->54% on SPX. Only used to
  // demote strength, never to invent a signal that was not there.
  // Tunable, not a constant: this is the dial the nightly evidence gate can
  // actually measure, because unlike confidenceThreshold it lives inside
  // generateSignal rather than the multi-timeframe wrapper.
  const ADX_TRENDING_MIN = (typeof strategySettings !== "undefined"
    && Number.isFinite(strategySettings.adxTrendingMin))
    ? strategySettings.adxTrendingMin : 20;
  const adxTrending = adxValue !== null && adxValue >= ADX_TRENDING_MIN;

  const MIN_RR = 1.5;

  // ── Gold/DXY divergence detection ────────────────────────────
  // Detected BEFORE the setup chain so a non-match falls through to the remaining
  // setups. Previously this lived in the chain behind a guard of
  // (dxyCloses && volConfirmed) alone. Only Gold is passed dxyCloses, and Gold's
  // volume ratio clears volConfirmed on nearly every cycle (contract volume against
  // a continuous-series average runs ~19x), so that guard captured Gold on almost
  // every pass and — being an else-if — terminated the chain whether a divergence
  // was found or not. BREAKOUT, MOMENTUM, TREND_FOLLOW, RANGE_TRADE_LONG/SHORT
  // and SQUEEZE_BREAKOUT were unreachable on Gold's daily timeframe; hoisting the
  // detection makes those six reachable again.
  // The SQUEEZE_BREAKOUT branch carried the identical defect and is now hoisted the
  // same way — see the squeeze-breakout detection below.
  const DIVERGENCE_LOOKBACK = 30;
  let divergence = null;
  if (dxyCloses && dxyCloses.length >= DIVERGENCE_LOOKBACK && volConfirmed && rsi !== null) {
    const assetWindow    = closes.slice(-DIVERGENCE_LOOKBACK);
    const dxyWindow      = dxyCloses.slice(-DIVERGENCE_LOOKBACK);
    const assetPriorLow  = Math.min(...assetWindow.slice(0, -1));
    const assetPriorHigh = Math.max(...assetWindow.slice(0, -1));
    const dxyPriorLow    = Math.min(...dxyWindow.slice(0, -1));
    const dxyPriorHigh   = Math.max(...dxyWindow.slice(0, -1));
    const dxyNow         = dxyWindow[dxyWindow.length - 1];
    // A NaN anywhere in either series makes every comparison below false, so a
    // bad feed leaves divergence null and the chain proceeds normally.
    const assetNewLow    = price <= assetPriorLow  * 0.997;
    const assetNewHigh   = price >= assetPriorHigh * 1.003;
    const dxyFailedHigh  = dxyNow < dxyPriorHigh   * 0.99;
    const dxyFailedLow   = dxyNow > dxyPriorLow    * 1.01;
    if (assetNewLow && dxyFailedHigh && rsi < 35) {
      divergence = { direction: "BUY",  dxyNow, dxyReference: dxyPriorHigh };
    } else if (assetNewHigh && dxyFailedLow && rsi > 65) {
      divergence = { direction: "SELL", dxyNow, dxyReference: dxyPriorLow };
    }
  }

  // ── BB squeeze-breakout detection ────────────────────────────
  // Hoisted out of the setup chain for the same reason DIVERGENCE was: the branch
  // used to be guarded by (bb && closes.length >= 60 && volConfirmed && macd) with
  // the real bandwidth-expansion test nested inside. Gold clears volConfirmed on
  // nearly every cycle (contract volume against a continuous-series average runs
  // ~18x), so Gold entered that branch on almost every pass and — being an else-if
  // — terminated the chain whether a breakout was found or not. That left
  // BB_SQUEEZE_WATCH and the diagnostic WAIT branch below unreachable on Gold,
  // which is why its signal came back with setup "WAIT" and an EMPTY reasons array:
  // the dashboard had nothing to display. Detecting here means a non-breakout falls
  // through to those two branches.
  const SQUEEZE_PRIOR_BANDWIDTH_MAX = 10;  // prior-window bandwidth that counts as compressed
  const SQUEEZE_LOOKBACK_BARS       = 5;   // bars back for the pre-expansion reading
  const SQUEEZE_MIN_BARS            = 60;  // need enough history for a stable prior BB
  let squeezeBreakout = null;
  if (bb && closes.length >= SQUEEZE_MIN_BARS && volConfirmed && macd) {
    const priorBB = calcBB(closes.slice(0, -SQUEEZE_LOOKBACK_BARS));
    if (priorBB && priorBB.bandwidth < SQUEEZE_PRIOR_BANDWIDTH_MAX && bb.bandwidth > priorBB.bandwidth) {
      if (price > bb.upper && macd.bullish) {
        squeezeBreakout = { direction: "BUY",  priorBandwidth: priorBB.bandwidth };
      } else if (price < bb.lower && !macd.bullish) {
        squeezeBreakout = { direction: "SELL", priorBandwidth: priorBB.bandwidth };
      }
    }
  }

  let setup = "WAIT", signal = "WAIT", strength = "NONE";
  let entry = price, stop = null, target = null, reasons = [];

  // ── BUY_DIP: pullback to EMA20 in uptrend or mixed with EMA50 support ──
  if (
    (inUptrend || (trend === "MIXED" && aboveEma50)) &&
    !aboveEma20 &&
    price >= ema20 * 0.978 &&       // within 2.2% of EMA20
    rsi !== null && rsi < 50 &&
    macd?.bullish
  ) {
    setup  = "BUY_DIP";
    signal = "BUY";
    const sl = atrStop15 ? parseFloat((entry - atrStop15).toFixed(2)) : parseFloat((entry * 0.985).toFixed(2));
    stop   = sl;
    target = parseFloat((entry + Math.abs(entry - sl) * 2.5).toFixed(2));
    strength = (rsi < 38 && volConfirmed) ? "STRONG" : rsi < 42 ? "MODERATE" : "NONE";
    reasons.push(`Uptrend intact — EMA50/200 structural support`);
    reasons.push(`RSI ${rsi} — dip into oversold territory`);
    reasons.push(`Pullback to EMA20 support zone`);
    if (macd.crossed) reasons.push(`MACD bullish crossover confirmed`);
    if (atrStop15) reasons.push(`ATR stop: ${atrStop15.toFixed(0)} (1.5x ATR)`);
  }

  // ── BUY_OVERSOLD: deep oversold + BB lower band ───────────────
  else if (
    (inUptrend || trend === "MIXED") &&
    rsi !== null && rsi < 30 &&
    bb && price <= bb.lower * 1.005
  ) {
    setup  = "BUY_OVERSOLD";
    signal = "BUY";
    const sl = atrStop15 ? parseFloat((entry - atrStop15).toFixed(2)) : parseFloat((entry * 0.985).toFixed(2));
    stop   = sl;
    target = parseFloat(Math.min(entry + Math.abs(entry - sl) * 2.0, bb.middle).toFixed(2));
    strength = rsi < 22 ? "STRONG" : "MODERATE";
    reasons.push(`RSI ${rsi} — extreme oversold`);
    reasons.push(`Price at/below BB lower band`);
    reasons.push(`Mean-reversion target: BB middle ${bb.middle}`);
  }

  // ── SELL_BOUNCE: rejection at EMA20 in downtrend or mixed below EMA50 ──
  else if (
    (inDowntrend || (trend === "MIXED" && !aboveEma50)) &&
    aboveEma20 &&
    price <= ema20 * 1.022 &&       // within 2.2% above EMA20
    rsi !== null && rsi > 50 &&
    macd && !macd.bullish
  ) {
    setup  = "SELL_BOUNCE";
    signal = "SELL";
    const sl = atrStop15 ? parseFloat((entry + atrStop15).toFixed(2)) : parseFloat((entry * 1.015).toFixed(2));
    stop   = sl;
    target = parseFloat((entry - Math.abs(sl - entry) * 2.5).toFixed(2));
    strength = (rsi > 62 && volConfirmed) ? "STRONG" : rsi > 56 ? "MODERATE" : "NONE";
    reasons.push(`Downtrend — below EMA50/200`);
    reasons.push(`RSI ${rsi} — overbought bounce into resistance`);
    reasons.push(`Rejection at EMA20 resistance zone`);
    if (atrStop15) reasons.push(`ATR stop: ${atrStop15.toFixed(0)} (1.5x ATR)`);
  }

  // ── DIVERGENCE: Gold/DXY correlation breakdown ───────────────
  // Gold and DXY normally move inversely. When gold breaks a 30-bar extreme
  // but DXY fails to confirm by ≥1%, it signals institutional divergence.
  // Detection ran above; this branch is entered only on an actual match, so a
  // non-divergent Gold cycle now continues down the chain.
  else if (divergence && divergence.direction === "BUY") {
    setup    = "DIVERGENCE";
    signal   = "BUY";
    const sl = atrStop15 ? parseFloat((entry - atrStop15).toFixed(2)) : parseFloat((entry * 0.985).toFixed(2));
    stop     = sl;
    target   = parseFloat((entry + Math.abs(entry - sl) * 2.5).toFixed(2));
    strength = rsi < 28 ? "STRONG" : "MODERATE";
    reasons.push(`${label} broke ${DIVERGENCE_LOOKBACK}-bar low but DXY failed new high (${divergence.dxyNow.toFixed(2)} vs ${divergence.dxyReference.toFixed(2)}) — correlation breakdown`);
    reasons.push(`RSI ${rsi} — selling not backed by real dollar strength`);
    reasons.push(`Volume ${volRatio}x avg — institutional participation confirmed`);
  }

  else if (divergence && divergence.direction === "SELL") {
    setup    = "DIVERGENCE";
    signal   = "SELL";
    const sl = atrStop15 ? parseFloat((entry + atrStop15).toFixed(2)) : parseFloat((entry * 1.015).toFixed(2));
    stop     = sl;
    target   = parseFloat((entry - Math.abs(sl - entry) * 2.5).toFixed(2));
    strength = rsi > 72 ? "STRONG" : "MODERATE";
    reasons.push(`${label} broke ${DIVERGENCE_LOOKBACK}-bar high but DXY failed new low (${divergence.dxyNow.toFixed(2)} vs ${divergence.dxyReference.toFixed(2)}) — correlation breakdown`);
    reasons.push(`RSI ${rsi} — rally not backed by real dollar weakness`);
    reasons.push(`Volume ${volRatio}x avg — institutional participation confirmed`);
  }

  // ── BREAKOUT: EMA200 reclaim with volume confirmation ─────────
  else if (
    ema200 &&
    price > ema200 &&
    price <= ema200 * 1.01 &&       // within 1% above EMA200
    rsi !== null && rsi > 50 && rsi < 68 &&
    macd?.bullish &&
    bb && bb.bandwidth < 20 &&
    volConfirmed                    // REQUIRE volume for breakout
  ) {
    setup  = "BREAKOUT";
    signal = "BUY";
    const sl = atrStop2x ? parseFloat((entry - atrStop2x).toFixed(2)) : parseFloat((ema200 * 0.985).toFixed(2));
    stop   = sl;
    target = parseFloat((entry + Math.abs(entry - sl) * 2.5).toFixed(2));
    strength = (volRatio !== null && volRatio >= 1.8) ? "STRONG" : "MODERATE";
    reasons.push(`Breaking above EMA200 — major structural level`);
    reasons.push(`BB squeeze ${bb.bandwidth}% — compressed energy releasing`);
    reasons.push(`Volume ${volRatio}x avg — institutional buying confirmed`);
  }

  // ── MOMENTUM: all EMAs aligned + MACD bullish (no longer requires fresh cross or volume spike)
  else if (
    inUptrend &&
    aboveEma50 && aboveEma20 &&
    rsi !== null && rsi > 52 && rsi < 72 &&
    macd?.bullish
  ) {
    setup  = "MOMENTUM";
    signal = "BUY";
    const sl = atrStop15 ? parseFloat((entry - atrStop15).toFixed(2)) : parseFloat((entry * 0.985).toFixed(2));
    stop   = sl;
    target = parseFloat((entry + Math.abs(entry - sl) * 2.0).toFixed(2));
    strength = (macd.crossed || (volRatio !== null && volRatio >= 1.8)) ? "STRONG" : rsi > 60 ? "MODERATE" : "NONE";
    reasons.push(`All EMAs aligned — trend structure intact`);
    reasons.push(`MACD bullish${macd.crossed ? " — fresh crossover" : ""} (histogram ${macd.histogram > 0 ? "+" : ""}${macd.histogram})`);
    if (volConfirmed) reasons.push(`Volume ${volRatio}x avg — institutional participation`);
    else reasons.push(`Volume ${volRatio ?? "?"}x avg (monitoring for breakout confirmation)`);
  }

  // ── TREND_FOLLOW: price in uptrend above all EMAs, MACD bullish — trend continuation ──
  else if (
    (inUptrend || trend === "MIXED" && aboveEma50 && aboveEma20) &&
    rsi !== null && rsi > 45 && rsi < 68 &&
    macd?.bullish &&
    ema200 && price > ema200 * 1.005
  ) {
    setup  = "TREND_FOLLOW";
    signal = "BUY";
    const sl = atrStop15 ? parseFloat((entry - atrStop15).toFixed(2)) : parseFloat((ema20 * 0.99).toFixed(2));
    stop   = sl;
    target = parseFloat((entry + Math.abs(entry - sl) * 2.0).toFixed(2));
    strength = (volConfirmed && rsi > 55) ? "STRONG" : rsi > 52 ? "MODERATE" : "NONE";
    reasons.push(`Above EMA200/50/20 — structural uptrend intact`);
    reasons.push(`RSI ${rsi} — not extended, room to run`);
    reasons.push(`MACD bullish — momentum aligned with trend`);
    if (volConfirmed) reasons.push(`Volume ${volRatio}x avg — participation confirmed`);
  }

  // ── RANGE_TRADE_LONG: buy BB lower in ranging/squeeze market ─────
  else if (
    bb && price <= bb.lower * 1.008 &&
    rsi !== null && rsi < 42 &&
    !inDowntrend
  ) {
    setup  = "RANGE_TRADE_LONG";
    signal = "BUY";
    const sl = atrStop15 ? parseFloat((entry - atrStop15).toFixed(2)) : parseFloat((entry * 0.985).toFixed(2));
    stop   = sl;
    target = parseFloat(Math.min(entry + Math.abs(entry - sl) * 2.0, bb.middle).toFixed(2));
    strength = rsi < 32 ? "STRONG" : "MODERATE";
    reasons.push(`Price at BB lower band — ranging market support`);
    reasons.push(`RSI ${rsi} — oversold within range`);
    reasons.push(`Target: BB middle (mean reversion)`);
  }

  // ── RANGE_TRADE_SHORT: sell BB upper in ranging/squeeze market ───
  else if (
    bb && price >= bb.upper * 0.992 &&
    rsi !== null && rsi > 58 &&
    !inUptrend
  ) {
    setup  = "RANGE_TRADE_SHORT";
    signal = "SELL";
    const sl = atrStop15 ? parseFloat((entry + atrStop15).toFixed(2)) : parseFloat((entry * 1.015).toFixed(2));
    stop   = sl;
    target = parseFloat(Math.max(entry - Math.abs(sl - entry) * 2.0, bb.middle).toFixed(2));
    strength = rsi > 68 ? "STRONG" : "MODERATE";
    reasons.push(`Price at BB upper band — ranging market resistance`);
    reasons.push(`RSI ${rsi} — overbought within range`);
    reasons.push(`Target: BB middle (mean reversion)`);
  }

  // ── SQUEEZE_BREAKOUT: price breaks out of BB squeeze with volume + MACD ─
  // Detection ran above; these two branches are entered only on an actual match,
  // so a non-breakout cycle now continues down the chain to BB_SQUEEZE_WATCH.
  else if (squeezeBreakout && squeezeBreakout.direction === "BUY") {
    setup  = "SQUEEZE_BREAKOUT";
    signal = "BUY";
    const sl = atrStop2x ? parseFloat((entry - atrStop2x).toFixed(2))
                          : parseFloat((bb.upper * 0.985).toFixed(2));
    stop   = sl;
    target = parseFloat((entry + Math.abs(entry - sl) * 2.5).toFixed(2));
    strength = (volRatio !== null && volRatio >= 2.0) ? "STRONG" : "MODERATE";
    reasons.push(`BB squeeze breakout — bandwidth expanded ${squeezeBreakout.priorBandwidth}% -> ${bb.bandwidth}%`);
    reasons.push(`Close above BB upper ${bb.upper} — confirmed bullish breakout`);
    reasons.push(`Volume ${volRatio}x avg — institutional momentum`);
    if (macd.crossed) reasons.push(`MACD bullish crossover — fresh momentum`);
  }

  else if (squeezeBreakout && squeezeBreakout.direction === "SELL") {
    setup  = "SQUEEZE_BREAKOUT";
    signal = "SELL";
    const sl = atrStop2x ? parseFloat((entry + atrStop2x).toFixed(2))
                          : parseFloat((bb.lower * 1.015).toFixed(2));
    stop   = sl;
    target = parseFloat((entry - Math.abs(sl - entry) * 2.5).toFixed(2));
    strength = (volRatio !== null && volRatio >= 2.0) ? "STRONG" : "MODERATE";
    reasons.push(`BB squeeze breakdown — bandwidth expanded ${squeezeBreakout.priorBandwidth}% -> ${bb.bandwidth}%`);
    reasons.push(`Close below BB lower ${bb.lower} — confirmed bearish breakdown`);
    reasons.push(`Volume ${volRatio}x avg — institutional selling`);
  }

  // ── BB_SQUEEZE_WATCH: tight squeeze — flag pending breakout ──────
  else if (bb && bb.bandwidth < 8) {
    setup  = "BB_SQUEEZE_WATCH";
    signal = "WAIT";
    const breakoutUp   = parseFloat((bb.upper * 1.002).toFixed(2));
    const breakoutDown = parseFloat((bb.lower * 0.998).toFixed(2));
    reasons.push(`BB bandwidth ${bb.bandwidth}% — extreme squeeze, breakout imminent`);
    reasons.push(`Watch for break above ${breakoutUp} (BUY) or below ${breakoutDown} (SELL)`);
    reasons.push(`RSI ${rsi} — position neutral, waiting for direction`);
    if (volRatio !== null) reasons.push(`Volume ${volRatio}x avg — low volume confirms squeeze`);
  }

  else {
    // WAIT — explain exactly what's needed to trigger each setup
    const needsUptrend   = !inUptrend   ? `price above EMA200 (${ema200 ? ema200.toFixed(0) : "N/A"})` : null;
    const needsOversold  = rsi !== null && rsi >= 50 ? `RSI below 50 (now ${rsi})` : null;
    const needsMACD      = !macd?.bullish ? `MACD bullish crossover` : null;
    const blockReasons   = [needsUptrend, needsOversold, needsMACD].filter(Boolean);
    reasons.push(`No setup: ${blockReasons.length > 0 ? blockReasons.join(", ") : "market not at key level"}`);
    reasons.push(`Trend: ${trend} | RSI: ${rsi} | BB bandwidth: ${bb?.bandwidth ?? "N/A"}%`);
    if (bb && bb.bandwidth < 15) reasons.push(`BB squeeze forming — breakout setup building`);
    if (volRatio !== null) reasons.push(`Volume ${volRatio}x avg`);
  }

  // ── Minimum R:R gate ─────────────────────────────────────────
  if (stop !== null && target !== null && signal !== "WAIT") {
    const calcRR = Math.abs(target - entry) / Math.abs(entry - stop);
    if (calcRR < MIN_RR) {
      const badRR = calcRR.toFixed(1);
      setup = "WAIT"; signal = "WAIT"; strength = "NONE";
      stop = null; target = null;
      reasons = [`Setup detected but R:R ${badRR} below minimum ${MIN_RR} — skip`];
    }
  }

  // ── Trend-strength gate ─────────────────────────────────────
  // Applied after the setups have run, so it can only ever DEMOTE a signal, never
  // create one. A STRONG call in a market with no measurable trend is the case
  // that gets stopped out, and auto mode trades STRONG only — so this is the
  // filter that decides whether money moves.
  // Demotes STRONG to MODERATE only. It deliberately does NOT push MODERATE to
  // NONE any more: that killed the setup outright in chop, and with the engine
  // already producing about one signal a month it was starving the self-learning
  // tables, which need 5 closed trades per setup before they can say anything.
  // Flagging a weak trend is useful; refusing to trade at all is what left
  // setupStats empty for 42 sessions.
  if (signal !== "WAIT" && adxValue !== null && !adxTrending) {
    if (strength === "STRONG") {
      strength = "MODERATE";
      reasons.push(`ADX ${adxValue} below ${ADX_TRENDING_MIN} — trend weak, not sized up`);
    } else if (strength === "MODERATE") {
      reasons.push(`ADX ${adxValue} — weak trend, trading at reduced conviction`);
    }
  } else if (signal !== "WAIT" && adxTrending) {
    reasons.push(`ADX ${adxValue} — trend confirmed`);
  }

  // ── Structural stop ─────────────────────────────────────────
  // Prefer the last confirmed swing point over a fixed ATR multiple: it sits where
  // the thesis is actually invalidated. Only adopted when it is TIGHTER than the
  // ATR stop, so this can reduce risk but never widen it beyond what the setup
  // already accepted. In testing, structural stops cut drawdown from ~12% to ~3%.
  //
  // The floor exists because "tighter than the ATR stop" had no lower bound. A
  // swing point sitting a few ticks from entry produced a stop distance near zero,
  // and since the target is unchanged, R/R is target-distance divided by that —
  // one SPX trade in the walk-forward came out at R/R 55.24 and contributed +55.2R
  // of a +39.5R cohort total. It WAS the result, and it flipped the cohort's sign.
  // Those are not edge, they are a division artifact, and live they would size a
  // position off a stop the next candle's noise removes.
  //
  // 0.5 ATR: still a 3x risk reduction against the 1.5 ATR stop, while anything
  // tighter is inside a single average bar's range. Below the floor the ATR stop
  // is kept, which is the pre-existing behaviour, so this can only reject a
  // structural stop - it never widens one or invents a new price.
  const structuralFloor = atrVal !== null ? atrVal * STRUCTURAL_STOP_MIN_ATR : null;
  const structuralStopIsUsable = (candidatePrice) =>
    structuralFloor === null || Math.abs(entry - candidatePrice) >= structuralFloor;

  if (stop !== null && signal === "BUY" && swingLow && swingLow.price < entry && swingLow.price > stop) {
    if (structuralStopIsUsable(swingLow.price)) {
      stop = parseFloat(swingLow.price.toFixed(2));
      reasons.push(`Stop at swing low ${stop} (${swingLow.barsAgo} bars ago) — structural, tighter than ATR`);
    } else {
      reasons.push(`Swing low ${swingLow.price.toFixed(2)} is inside ${STRUCTURAL_STOP_MIN_ATR} ATR of entry — keeping the ATR stop`);
    }
  } else if (stop !== null && signal === "SELL" && swingHigh && swingHigh.price > entry && swingHigh.price < stop) {
    if (structuralStopIsUsable(swingHigh.price)) {
      stop = parseFloat(swingHigh.price.toFixed(2));
      reasons.push(`Stop at swing high ${stop} (${swingHigh.barsAgo} bars ago) — structural, tighter than ATR`);
    } else {
      reasons.push(`Swing high ${swingHigh.price.toFixed(2)} is inside ${STRUCTURAL_STOP_MIN_ATR} ATR of entry — keeping the ATR stop`);
    }
  }

  const rr = (stop !== null && target !== null)
    ? parseFloat((Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(1))
    : null;

  return {
    label, ticker, price, signal, setup, strength,
    entry:  parseFloat(entry.toFixed(2)),
    stop:   stop   !== null ? parseFloat(stop.toFixed(2))   : null,
    target: target !== null ? parseFloat(target.toFixed(2)) : null,
    rr,
    atr:    atrVal ? parseFloat(atrVal.toFixed(2)) : null,
    indicators: {
      rsi,
      ema20:  parseFloat(ema20.toFixed(2)),
      ema50:  parseFloat(ema50.toFixed(2)),
      ema200: ema200 ? parseFloat(ema200.toFixed(2)) : null,
      bb,
      macd,
      adx: adxValue,
      plusDI:  adxData ? adxData.plusDI  : null,
      minusDI: adxData ? adxData.minusDI : null,
    },
    structure: {
      swingLow:  swingLow  ? parseFloat(swingLow.price.toFixed(2))  : null,
      swingHigh: swingHigh ? parseFloat(swingHigh.price.toFixed(2)) : null,
      trending:  adxTrending,
    },
    trend,
    volume: { last: Math.round(lastVol), avg: avgVol ? Math.round(avgVol) : null, ratio: volRatio, confirmed: volConfirmed },
    reasons,
    updatedAt: new Date().toISOString()
  };
}

// ── Multi-timeframe wrapper ───────────────────────────────────
function generateSignalMTF(label, ticker, dailyData, h4Data, h1Data = null, dxyDailyCloses = null) {
  const daily = generateSignal(label, ticker, dailyData.closes, dailyData.highs, dailyData.lows, dailyData.volumes ?? [], dxyDailyCloses);
  if (!daily) return null;

  let h4 = null;
  try {
    if (h4Data?.closes?.length >= 50)
      h4 = generateSignal(label, ticker, h4Data.closes, h4Data.highs, h4Data.lows, h4Data.volumes ?? []);
  } catch (e) {}

  let h1 = null;
  try {
    if (h1Data?.closes?.length >= 50)
      h1 = generateSignal(label, ticker, h1Data.closes, h1Data.highs, h1Data.lows, h1Data.volumes ?? []);
  } catch (e) {}

  // Confidence: rises when both timeframes agree
  const isH4Only = h4 && h4.signal !== "WAIT" && daily.signal === "WAIT";
  // Daily fired and H4 has NO opinion — distinct from H4 actively disagreeing.
  // Both used to collapse to confidence 40, which no boost can lift past the 65
  // gate (40 + 5 volume + 10 setup = 55), so the whole cohort was silently dead.
  const isDailyNeutralH4 = daily.signal !== "WAIT" && h4 !== null && h4.signal === "WAIT";
  let confidence = daily.signal === "WAIT" ? 0 : 40;
  if (h4 && h4.signal === daily.signal && daily.signal !== "WAIT") {
    confidence = daily.strength === "STRONG" || h4.strength === "STRONG" ? 88 : 72;
    if (daily.strength === "STRONG" && h4.strength === "STRONG") confidence = 95;
  } else if (isDailyNeutralH4 && ticker === "GC=F") {
    // Gold only. Measured on a 60/40 chronological split of XAUUSD history, read
    // off the held-out TEST half (R/trade, cost 0.05R):
    //   MODERATE  +0.464 over 424 trades, 49% win  <- largest cohort in the system
    //   STRONG    +0.347 over  47 trades, 30% win
    //   NONE      -0.103 over 151 trades           <- stays blocked at 40
    // The same cohort on BTC (+0.119 train -> -0.088 test) and SPX (+0.209 ->
    // -0.134) flips sign out-of-sample, so neither is admitted here. Requires a
    // real H4 read: h4 === null means we could not compute that timeframe at all,
    // which is not the same as H4 having no opinion.
    confidence = daily.strength === "MODERATE" ? 72
               : daily.strength === "STRONG"   ? 70
               : 40;
  } else if (isH4Only) {
    // H4-only: gate by asset (SPX has negative edge from held-out backtest) and H4 strength
    if (ticker === "^GSPC") {
      confidence = 45; // SPX: needs exceptional quality boosts to clear 65 gate
    } else if (ticker === "GC=F") {
      // Gold H4-only: PF 1.40 in held-out backtest — STRONG fires directly.
      //
      // MODERATE is split by what the DAILY was doing, because those are two
      // different populations and averaging them hides both. Measured 2026-08-01 on
      // a repaired walk-forward replay (60/40 chronological split, cost 0.05R, TEST
      // = held-out half, engine's own targets):
      //
      //   daily setup BB_SQUEEZE_WATCH   TRAIN +0.179 (n=26)  TEST +0.607 (n=27)
      //   daily setup WAIT               TRAIN -0.518 (n= 9)  TEST +0.366 (n=21)
      //   both together, i.e. one flat   TRAIN -0.000 (n=35)  TEST +0.502 (n=48)
      //   number for MODERATE
      //
      // Raising MODERATE unconditionally nets EXACTLY ZERO in the train half — the
      // squeeze cohort's edge pays for the WAIT cohort's losses. Gated to the
      // squeeze it is positive in both halves, which is the only form of this
      // change worth shipping. Revert by deleting the ternary, nothing else.
      //
      // Why a squeeze is different: BB_SQUEEZE_WATCH means the daily has compressed
      // and has no directional opinion yet, so an H4 setup is the first read on
      // which way it resolves. A plain daily WAIT means the daily looked and found
      // nothing — a weaker thing for H4 to disagree with.
      //
      // These numbers came from a harness that was itself repaired the same day
      // (b55b5f5); every earlier Gold measurement dropped this cohort entirely.
      //
      // GOLD_SQUEEZE_MODERATE_CONFIDENCE is 70 to sit exactly on the live gate.
      // It is a pinned constant rather than `strategySettings.confidenceThreshold`
      // on purpose: the walk-forward harness lowers that threshold to 40 to expose
      // sub-gate cohorts, so a follower would have been REPLAYED at 40 and dropped
      // from the very gate-70 population it needs to be measured inside. Pinned, the
      // replay sees exactly what live sees.
      //
      // The coupling is real and load-bearing: raise confidenceThreshold above 70
      // and this cohort stops firing entirely. Re-measure it then, do not carry it.
      const goldSqueezeModerate = daily.setup === "BB_SQUEEZE_WATCH"
        ? GOLD_SQUEEZE_MODERATE_CONFIDENCE
        : 55;
      confidence = h4.strength === "STRONG" ? 68
                 : h4.strength === "MODERATE" ? goldSqueezeModerate
                 : 40;
    } else {
      // BTC H4-only: PF 1.08 (marginal) — STRONG needs a small quality boost to clear gate
      confidence = h4.strength === "STRONG" ? 63 : h4.strength === "MODERATE" ? 50 : 40;
    }
  }
  // Direction to use for macro filters and final gate: H4 provides direction when daily is WAIT
  const signalDir = isH4Only ? h4.signal : daily.signal;

  // Triple alignment: Daily + 4H + 1H all agree
  if (h4 && h1 && h4.signal === daily.signal && h1.signal === daily.signal && daily.signal !== "WAIT") {
    const allStrong = daily.strength === "STRONG" && h4.strength === "STRONG";
    confidence = allStrong ? 97 : 88;
  }

  // The timeframe that actually produced this signal. Everything below reads
  // quality off it rather than off `daily` unconditionally.
  //
  // This is the fix for a cohort that was dead by arithmetic. In the H4-only case
  // `daily.signal` is "WAIT" by definition — that is what isH4Only MEANS — so the
  // volume boost below could never apply to it, and the setup boosts were skipped
  // outright by an `if (!isH4Only)` guard. That made the H4-only confidences above
  // terminal values, not starting points: BTC STRONG was pinned at 63 against a 65
  // gate and SPX at 45, while the comments beside them claimed a "small quality
  // boost" and "exceptional quality boosts" would lift them over. No such boost
  // existed. Measured live 2026-07-30: BTC sat at exactly 63 with H4 reading BUY /
  // STRONG UPTREND, two points short, unable to move.
  //
  // Reading quality from h4 in the H4-only case is the same principle the entry,
  // stop and target already follow (see the entry/stop selection below) — all legs
  // of an H4-only trade come from the H4 timeframe, and confidence is now no
  // exception. This does not lower the gate; it restores the intended path to it.
  const signalTf = isH4Only ? h4 : daily;

  // Volume confirmation boost
  if (signalTf.volume?.confirmed && (signalTf.signal === "BUY" || signalTf.signal === "SELL")) {
    confidence = Math.min(100, confidence + 5);
  }

  // Setup quality boost
  if (signalTf.setup === "BREAKOUT"         && signalTf.volume?.confirmed) confidence = Math.min(100, confidence + 7);
  if (signalTf.setup === "SQUEEZE_BREAKOUT" && signalTf.volume?.confirmed) confidence = Math.min(100, confidence + 10);
  if (signalTf.setup === "DIVERGENCE"       && signalTf.strength === "STRONG") confidence = Math.min(100, confidence + 6);
  if (signalTf.setup === "MOMENTUM"         && signalTf.volume?.confirmed) confidence = Math.min(100, confidence + 5);
  if (signalTf.setup === "BUY_DIP"          && signalTf.strength === "STRONG") confidence = Math.min(100, confidence + 3);
  if (signalTf.setup === "SELL_BOUNCE"      && signalTf.strength === "STRONG") confidence = Math.min(100, confidence + 3);

  // Self-learning boost — system learns from past trades on this setup.
  // Reasons are always pushed onto daily.reasons because that is the array the
  // returned object carries (the spread below is `...daily`), regardless of which
  // timeframe supplied the setup.
  const learnBoost = getLearningBoost(signalTf.setup);
  if (learnBoost !== 0) {
    confidence = Math.max(0, Math.min(100, confidence + learnBoost));
    if (learnBoost > 0) daily.reasons.push(`✅ Learned: ${signalTf.setup} performing above avg (+${learnBoost})`);
    else daily.reasons.push(`⚠ Learned: ${signalTf.setup} underperforming (${learnBoost})`);
  }

  // Name the source timeframe on H4-only entries. Without this the dashboard shows
  // a daily setup of "WAIT" beside a live BUY and there is no way to tell which
  // timeframe the levels came from.
  if (isH4Only) {
    daily.reasons.push(`4H entry: ${h4.setup} ${h4.signal} (${h4.strength}) — daily has no setup`);
  }

  // Preliminary signal for macro filter checks
  let finalSignal = confidence >= strategySettings.confidenceThreshold ? signalDir : "WAIT";

  // DXY filter: strong dollar hurts Gold and BTC
  const dxy = priceCache.dxy;
  if (dxy && dxy > 105 && (ticker === "GC=F" || ticker === "BTC-USD") && finalSignal === "BUY") {
    confidence = Math.max(0, confidence - 10);
    daily.reasons.push(`⚠ DXY ${dxy} (strong dollar — headwind for ${label})`);
  }
  // VIX filter: high fear = reduce confidence on BUY signals
  if (priceCache.vix && priceCache.vix > 25 && finalSignal === "BUY") {
    confidence = Math.max(0, confidence - 8);
    daily.reasons.push(`⚠ VIX ${priceCache.vix} elevated — risk-off environment`);
  }

  // Fear & Greed sentiment filter — extreme greed = risky BUY, extreme fear = risky SELL
  const fg = sentimentCache.fearGreed;
  if (fg !== null && fg !== undefined) {
    if (fg <= 20 && finalSignal === "SELL") {
      confidence = Math.max(0, confidence - 7);
      daily.reasons.push(`⚠ Fear & Greed ${fg} (Extreme Fear) — markets may be oversold, SELL risk elevated`);
    } else if (fg <= 20 && finalSignal === "BUY") {
      confidence = Math.min(100, confidence + 6);
      daily.reasons.push(`✅ Fear & Greed ${fg} (Extreme Fear) — contrarian BUY opportunity, oversold`);
    } else if (fg >= 80 && finalSignal === "BUY") {
      confidence = Math.max(0, confidence - 7);
      daily.reasons.push(`⚠ Fear & Greed ${fg} (Extreme Greed) — markets may be overbought, BUY risk elevated`);
    } else if (fg >= 80 && finalSignal === "SELL") {
      confidence = Math.min(100, confidence + 6);
      daily.reasons.push(`✅ Fear & Greed ${fg} (Extreme Greed) — contrarian SELL, markets overheated`);
    } else if (fg >= 60 && finalSignal === "BUY") {
      confidence = Math.min(100, confidence + 3);
      daily.reasons.push(`✅ Fear & Greed ${fg} (Greed) — risk appetite supports BUY`);
    } else if (fg <= 40 && finalSignal === "SELL") {
      confidence = Math.min(100, confidence + 3);
      daily.reasons.push(`✅ Fear & Greed ${fg} (Fear) — fear regime supports SELL`);
    }
  }

  // Cross-asset confirmation gate — uses previous-cycle cache (always available)
  {
    const spxSig = signalCache.spx?.signal;
    const btcSig = signalCache.btc?.signal;
    const dxyChg = priceCache.dxyChange ?? 0;

    if (ticker === "BTC-USD") {
      if (finalSignal === "BUY" && spxSig === "SELL") {
        confidence = Math.max(0, confidence - 12);
        daily.reasons.push(`⚠ Cross-asset: SPX is SELL — risk-off headwind for BTC`);
      } else if (finalSignal === "BUY" && spxSig === "BUY") {
        confidence = Math.min(100, confidence + 5);
        daily.reasons.push(`✅ Cross-asset: SPX confirms BUY — risk-on tailwind`);
      }
    }

    if (ticker === "GC=F") {
      if (finalSignal === "BUY" && dxyChg > 0.5) {
        confidence = Math.max(0, confidence - 10);
        daily.reasons.push(`⚠ Cross-asset: DXY +${dxyChg.toFixed(1)}% — rising dollar headwind for Gold`);
      } else if (finalSignal === "BUY" && dxyChg < -0.3) {
        confidence = Math.min(100, confidence + 5);
        daily.reasons.push(`✅ Cross-asset: DXY ${dxyChg.toFixed(1)}% — falling dollar tailwind for Gold`);
      }
      // Safe-haven boost when risk assets are both selling — BUY Gold only
      if (finalSignal === "BUY" && btcSig === "SELL" && spxSig === "SELL") {
        confidence = Math.min(100, confidence + 8);
        daily.reasons.push(`✅ Cross-asset: Risk-off (BTC+SPX SELL) — safe haven demand for Gold`);
      }
    }

    if (ticker === "SPY") {
      if (finalSignal === "BUY" && btcSig === "BUY") {
        confidence = Math.min(100, confidence + 5);
        daily.reasons.push(`✅ Cross-asset: BTC also BUY — broad risk-on alignment`);
      } else if (finalSignal === "BUY" && btcSig === "SELL") {
        confidence = Math.max(0, confidence - 8);
        daily.reasons.push(`⚠ Cross-asset: BTC diverging SELL while SPY buying — caution`);
      }
    }
  }

  // Pivots from last completed daily candle
  const n = dailyData.closes.length;
  const pivots = n >= 2 ? calcPivots(dailyData.highs[n - 2], dailyData.lows[n - 2], dailyData.closes[n - 2]) : null;

  // Refine stop/target using pivot levels
  let refinedStop   = daily.stop;
  let refinedTarget = daily.target;
  if (pivots && daily.signal === "BUY" && daily.stop !== null) {
    // Tighten stop to pivot S1 if it's above the ATR stop (closer to entry = better R:R)
    if (pivots.s1 > daily.stop && pivots.s1 < daily.entry) refinedStop = pivots.s1;
    // Use R1 as target if it's between entry and original target (more conservative, more likely to hit)
    if (pivots.r1 > daily.entry && daily.target !== null && pivots.r1 < daily.target) refinedTarget = pivots.r1;
  }
  if (pivots && daily.signal === "SELL" && daily.stop !== null) {
    if (pivots.r1 < daily.stop && pivots.r1 > daily.entry) refinedStop = pivots.r1;
    if (pivots.s1 < daily.entry && daily.target !== null && pivots.s1 > daily.target) refinedTarget = pivots.s1;
  }
  // Only apply if refined R:R still meets minimum
  if (refinedStop !== null && refinedTarget !== null) {
    const refinedRR = Math.abs(refinedTarget - daily.entry) / Math.abs(daily.entry - refinedStop);
    if (refinedRR < 1.5) { refinedStop = daily.stop; refinedTarget = daily.target; }
  }

  // Confidence is dual-purpose: it is not only the fire/no-fire gate, it is also
  // what server/sizing.js scales position size from (>= 75 -> 1.25x risk,
  // >= 90 -> 1.5x). The Gold neutral-H4 cohort was validated at CONSTANT risk —
  // the replay harness holds R fixed and stubs the macro caches — so letting it
  // inherit a size multiplier would trade it at a risk level nothing here has
  // measured. Gold's volConfirmed is true on nearly every cycle, so the +5 volume
  // boost alone would put every trade in this cohort at 77 and size it 1.25x.
  // Hold it at 1.0x until it has live closed trades of its own.
  if (isDailyNeutralH4 && ticker === "GC=F" && confidence >= SIZING_BOOST_MIN_CONFIDENCE) {
    confidence = SIZING_BOOST_MIN_CONFIDENCE - 1;
  }

  // Require confidence ≥ 65 for a signal to fire
  finalSignal = confidence >= strategySettings.confidenceThreshold ? signalDir : "WAIT";
  // Banded off the same threshold that decides whether the signal fires at all.
  // With a fixed 70 here, anything landing 65-69 fired as a real BUY/SELL carrying
  // strength NONE — which mt5_bridge.py drops in AUTO mode. The signal showed on
  // the dashboard and the trade silently never happened. Tying the MODERATE band
  // to confidenceThreshold makes "fires => tradeable" an invariant that survives
  // the threshold being changed from the dashboard.
  const finalStrength = confidence >= 90 ? "STRONG"
                      : confidence >= strategySettings.confidenceThreshold ? "MODERATE"
                      : "NONE";

  // Market regime
  const bbW = daily.indicators?.bb?.bandwidth;
  const regime =
    (daily.trend === "STRONG UPTREND" || daily.trend === "STRONG DOWNTREND") ? "TRENDING" :
    (bbW && bbW < 8) ? "SQUEEZE" :
    (bbW && bbW > 25) ? "VOLATILE" : "RANGING";

  const finalRR = (refinedStop !== null && refinedTarget !== null)
    ? parseFloat((Math.abs(refinedTarget - daily.entry) / Math.abs(daily.entry - refinedStop)).toFixed(1))
    : daily.rr;

  return {
    ...daily,
    signal:     finalSignal,
    strength:   finalStrength,
    confidence,
    regime,
    // H4-only entries take stop/target from h4 below, so entry has to come from h4
    // too. Spreading ...daily leaves entry on the daily close while the stop sits
    // on the 4H close; when those diverge |entry - stop| collapses, which inflated
    // replayed R:R as far as 24R and — under risk-based sizing, which divides by
    // stop distance — would size the position into the maxLotSize ceiling.
    entry:      (isH4Only && h4?.entry != null) ? h4.entry : daily.entry,
    stop:       (refinedStop   != null && refinedStop   !== 0) ? parseFloat(refinedStop.toFixed(2))   : (daily.stop   ?? (h4?.stop   != null ? parseFloat(h4.stop.toFixed(2))   : null)),
    target:     (refinedTarget != null && refinedTarget !== 0) ? parseFloat(refinedTarget.toFixed(2)) : (daily.target ?? (h4?.target != null ? parseFloat(h4.target.toFixed(2)) : null)),
    rr:         finalRR ?? h4?.rr ?? null,
    h4: h4 ? { signal: h4.signal, trend: h4.trend, rsi: h4.indicators?.rsi } : null,
    h1: h1 ? { signal: h1.signal, trend: h1.trend, rsi: h1.indicators?.rsi } : null,
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

// Yahoo's `range` counts CALENDAR days, not bars. 210d therefore yields a
// different bar count per asset depending on how many days a week it trades:
// measured 2026-07-28, BTC-USD 210 bars (24/7), ^GSPC 209, but GC=F only 173.
// 173 is under the 200 that EMA200 needs, so Gold's `ema200` came back null,
// `aboveEma200` was null, and `trend` could not match any of its four EMA200
// branches — it was pinned to "MIXED" forever, which made inUptrend/inDowntrend
// permanently false and MOMENTUM, BREAKOUT and TREND_FOLLOW unreachable on
// Gold's daily timeframe. 300d returns 248 bars and fixes it.
//
// Deliberately per-symbol rather than a global bump: only Gold's cohorts were
// validated on held-out data. Widening BTC and SPX would shift their EMA200 and
// swing points and change signals nobody has measured.
const DAILY_RANGE_DEFAULT = "210d";
const DAILY_RANGE_BY_SYMBOL = { "GC=F": "300d" };

// The confidence at which server/sizing.js starts scaling risk above 1.0x. Kept
// here because generateSignalMTF has to know where that boundary is to avoid
// handing a size multiplier to a cohort that was measured at constant risk.
const SIZING_BOOST_MIN_CONFIDENCE = 75;

// Minimum distance, in ATR, between entry and a structural stop before that stop
// is allowed to replace the ATR stop. Without a floor a swing point sitting a few
// ticks from entry produced a near-zero stop distance and an R/R in the dozens:
// one SPX walk-forward trade came out at 55.24 and was +55.2R of a +39.5R cohort.
// 0.5 is still a 3x risk reduction against the 1.5 ATR stop; anything tighter sits
// inside one average bar's range.
const STRUCTURAL_STOP_MIN_ATR = 0.5;

// Confidence given to Gold H4 MODERATE when the DAILY is in a BB squeeze. Sits on
// the live gate (confidenceThreshold 70) so the cohort trades; see the block in
// generateSignalMTF for why this is pinned rather than following the setting.
const GOLD_SQUEEZE_MODERATE_CONFIDENCE = 70;

async function fetchCandles(symbol) {
  const range = DAILY_RANGE_BY_SYMBOL[symbol] ?? DAILY_RANGE_DEFAULT;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
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
  const volumes = quote.volume.map(v => v ?? 0);
  return { closes, highs, lows, volumes, meta: result.meta };
}

async function fetchCandles4H(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=60m&range=60d`;
  const res = await axios.get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } });
  const result = res.data?.chart?.result?.[0];
  if (!result) throw new Error("No 1H data");
  const q = result.indicators.quote[0];
  const rawC = q.close, rawH = q.high, rawL = q.low, rawV = q.volume ?? [];
  const closes = [], highs = [], lows = [], volumes = [];
  for (let i = 3; i < rawC.length; i += 4) {
    const c4 = rawC.slice(i - 3, i + 1).filter(Boolean);
    const h4 = rawH.slice(i - 3, i + 1).filter(Boolean);
    const l4 = rawL.slice(i - 3, i + 1).filter(Boolean);
    const v4 = rawV.slice(i - 3, i + 1).filter(v => v != null);
    if (!c4.length) continue;
    closes.push(c4[c4.length - 1]);
    highs.push(Math.max(...h4));
    lows.push(Math.min(...l4));
    volumes.push(v4.reduce((a,b) => a+b, 0));
  }
  return { closes, highs, lows, volumes };
}

async function fetchCandles1H(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=30m&range=30d`;
  const res = await axios.get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } });
  const result = res.data?.chart?.result?.[0];
  if (!result) throw new Error("No 30m data");
  const q = result.indicators.quote[0];
  const rawC = q.close, rawH = q.high, rawL = q.low, rawV = q.volume ?? [];
  const closes = [], highs = [], lows = [], volumes = [];
  for (let i = 1; i < rawC.length; i += 2) {
    const c2 = rawC.slice(i-1, i+1).filter(Boolean);
    const h2 = rawH.slice(i-1, i+1).filter(Boolean);
    const l2 = rawL.slice(i-1, i+1).filter(Boolean);
    const v2 = rawV.slice(i-1, i+1).filter(v => v != null);
    if (!c2.length) continue;
    closes.push(c2[c2.length - 1]);
    highs.push(Math.max(...h2));
    lows.push(Math.min(...l2));
    volumes.push(v2.reduce((a,b) => a+b, 0));
  }
  return { closes, highs, lows, volumes };
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
    const [btcRes, goldRes, spxRes, dxyRes, vixRes] = await Promise.allSettled([
      axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        { timeout: 8000, headers: { "User-Agent": "SmartEntry/12.0" } }),
      yahooPrice("GC=F"),
      yahooPrice("^GSPC"),
      yahooPrice("DX-Y.NYB"),
      yahooPrice("^VIX")
    ]);
    if (btcRes.status === "fulfilled") {
      priceCache.btc       = parseFloat((btcRes.value.data?.bitcoin?.usd ?? priceCache.btc ?? 0).toFixed(2));
      priceCache.btcChange = parseFloat((btcRes.value.data?.bitcoin?.usd_24h_change ?? 0).toFixed(2));
    }
    if (goldRes.status === "fulfilled") { priceCache.gold = goldRes.value.price; priceCache.goldChange = goldRes.value.change; }
    if (spxRes.status  === "fulfilled") { priceCache.spx  = spxRes.value.price;  priceCache.spxChange  = spxRes.value.change; }
    if (dxyRes.status  === "fulfilled") { priceCache.dxy  = dxyRes.value.price;  priceCache.dxyChange  = dxyRes.value.change; }
    if (vixRes.status  === "fulfilled") { priceCache.vix  = vixRes.value.price; }
    priceCache.updated = new Date().toISOString();
    console.log(`[prices] BTC $${priceCache.btc} | Gold $${priceCache.gold} | SP500 $${priceCache.spx} | DXY ${priceCache.dxy} | VIX ${priceCache.vix}`);
  } catch (e) { console.error("fetchPrices:", e.message); }
}

// ── MT5 candle ingest / selection ─────────────────────────────

// Every indicator indexes closes/highs/lows in lockstep, so a ragged set would
// misalign highs against closes and silently corrupt ATR, swing points and the
// structural stop. Length equality is checked, not assumed.
function sanitizeBars(bars, minBars) {
  if (!bars || typeof bars !== "object") return null;
  const { closes, highs, lows, volumes } = bars;
  const usable = (series) => Array.isArray(series)
    && series.length >= minBars
    && series.every(v => typeof v === "number" && Number.isFinite(v));
  if (!usable(closes) || !usable(highs) || !usable(lows)) return null;
  if (highs.length !== closes.length || lows.length !== closes.length) return null;
  // Volumes are optional: some brokers report tick_volume only on some symbols.
  // An empty array makes volRatio null and volConfirmed false, which disables the
  // volume-confirmed setups rather than inventing confirmation from zeros.
  const alignedVolumes = (usable(volumes) && volumes.length === closes.length) ? volumes : [];
  return { closes, highs, lows, volumes: alignedVolumes };
}

// Returns the MT5 bar set for an asset, or null to mean "use Yahoo". Bars are
// sanitized on ingest, so this only decides freshness and completeness.
function mt5BarsFor(assetKey) {
  const entry = mt5CandleCache[assetKey];
  if (!entry) return null;
  if (Date.now() - new Date(entry.receivedAt).getTime() > MT5_CANDLE_MAX_AGE_MS) return null;
  // No usable daily series means no signal at all — generateSignalMTF requires it —
  // so there is nothing to gain from taking H4/H1 from MT5 and daily from Yahoo.
  // Mixing feeds across timeframes is also how entry and stop ended up on
  // different instruments before; keep one source per asset per cycle.
  if (!entry.bars?.d1) return null;
  return { symbol: entry.symbol, daily: entry.bars.d1, h4: entry.bars.h4, h1: entry.bars.h1 };
}

async function refreshSignals() {
  console.log("[signals] Refreshing all assets in PARALLEL (Daily + 4H + 1H)…");
  const assets = [
    { key: "btc",  label: "Bitcoin",    symbol: "BTC-USD" },
    { key: "gold", label: "Gold/XAUUSD", symbol: "GC=F"   },
    { key: "spx",  label: "S&P500",     symbol: "^GSPC"   }
  ];
  // Fetch DXY daily candles once — used by Gold DIVERGENCE setup
  let dxyDailyCloses = null;
  try {
    const dxy = await fetchCandles("DX-Y.NYB");
    dxyDailyCloses = dxy?.closes ?? null;
  } catch (e) { console.error("[signals] DXY fetch:", e.message); }

  await Promise.all(assets.map(async (a) => {
    try {
      // MT5 first: those are the bars for the symbol this asset is actually filled
      // on. Yahoo is the fallback for when no bridge is running, its series is too
      // short for EMA200, or its last push has gone stale.
      const mt5Bars = mt5BarsFor(a.key);
      let dailyData, h4Data, h1Data, dataSource, sourceSymbol;

      if (mt5Bars) {
        dailyData    = mt5Bars.daily;
        h4Data       = mt5Bars.h4;
        h1Data       = mt5Bars.h1;
        dataSource   = "mt5";
        sourceSymbol = mt5Bars.symbol;
      } else {
        const [daily, h4, h1] = await Promise.allSettled([
          fetchCandles(a.symbol),
          fetchCandles4H(a.symbol),
          fetchCandles1H(a.symbol)
        ]);
        dailyData    = daily.status === "fulfilled" ? daily.value : null;
        h4Data       = h4.status    === "fulfilled" ? h4.value    : null;
        h1Data       = h1.status    === "fulfilled" ? h1.value    : null;
        dataSource   = "yahoo";
        sourceSymbol = a.symbol;
      }

      if (!dailyData) { console.error(`[signals] ${a.label}: no daily data`); return; }
      const dxyForAsset = a.key === "gold" ? dxyDailyCloses : null;
      signalCache[a.key] = generateSignalMTF(a.label, a.symbol, dailyData, h4Data, h1Data, dxyForAsset);
      // Stamped on the signal so every consumer — dashboard, bridge, daily plan —
      // can tell which instrument produced these levels. Without this, a Gold
      // signal carrying futures levels is indistinguishable from one carrying spot
      // levels, and that ambiguity is what made the entry/stop mismatch invisible.
      if (signalCache[a.key]) {
        signalCache[a.key].dataSource   = dataSource;
        signalCache[a.key].sourceSymbol = sourceSymbol;
        signalCache[a.key].bars = {
          d1: dailyData.closes.length,
          h4: h4Data?.closes.length ?? 0,
          h1: h1Data?.closes.length ?? 0,
        };
      }
      const s = signalCache[a.key];
      console.log(`[signals] ${a.label}: ${s?.signal} (${s?.strength}) conf:${s?.confidence}% regime:${s?.regime} vol:${s?.volume?.ratio ?? "?"}x`);
    } catch (e) {
      console.error(`[signals] ${a.label} error:`, e.message);
    }
  }));
  signalCache.updatedAt = new Date().toISOString();
  // Record this cycle to history so the command center can show what happened
  signalHistory.unshift({
    t: signalCache.updatedAt,
    btc:  signalCache.btc  ? { s: signalCache.btc.signal,  c: signalCache.btc.confidence,  regime: signalCache.btc.regime,  setup: signalCache.btc.setup,  reasons: (signalCache.btc.reasons  || []).slice(0,6), entry: signalCache.btc.entry,  stop: signalCache.btc.stop,  target: signalCache.btc.target  } : null,
    gold: signalCache.gold ? { s: signalCache.gold.signal, c: signalCache.gold.confidence, regime: signalCache.gold.regime, setup: signalCache.gold.setup, reasons: (signalCache.gold.reasons || []).slice(0,6), entry: signalCache.gold.entry, stop: signalCache.gold.stop, target: signalCache.gold.target } : null,
    spx:  signalCache.spx  ? { s: signalCache.spx.signal,  c: signalCache.spx.confidence,  regime: signalCache.spx.regime,  setup: signalCache.spx.setup,  reasons: (signalCache.spx.reasons  || []).slice(0,6), entry: signalCache.spx.entry,  stop: signalCache.spx.stop,  target: signalCache.spx.target  } : null,
  });
  if (signalHistory.length > 100) signalHistory.length = 100;
  try { hermes.runHermesCycle(signalCache, priceCache); } catch (e) { console.error("[hermes] cycle error:", e.message); }
  refreshAnalysis();
}

// ── Unusual Whales ────────────────────────────────────────────
async function fetchCongress() {
  if (!UW_API_KEY) return;
  try {
    const res = await axios.get(`${UW_BASE}/congress/trades`, { headers: getUwHeaders(), timeout: 10000, params: { limit: 20 } });
    congressCache = res.data;
  } catch (e) { console.error("UW congress:", e.message); }
}

async function fetchFlow() {
  if (!UW_API_KEY) return;
  try {
    const res = await axios.get(`${UW_BASE}/flow/alerts`, { headers: getUwHeaders(), timeout: 10000, params: { limit: 20 } });
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

const WATCHLIST_PRIORITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

function buildWatchlist() {
  const entries = [
    { ticker: "BTC",  signal: signalCache.btc  },
    { ticker: "GOLD", signal: signalCache.gold },
    { ticker: "SPX",  signal: signalCache.spx  }
  ];

  return entries
    .filter(e => e.signal)
    .map(({ ticker, signal: s }) => {
      const bandwidth = s.indicators?.bb?.bandwidth;
      const squeeze    = bandwidth != null && bandwidth < 8;
      const active     = s.signal !== "WAIT";
      const priority   = active ? "HIGH" : (squeeze || (s.confidence ?? 0) >= 50) ? "MEDIUM" : "LOW";
      const action     = active
        ? `${s.signal} live — ${s.confidence}% confidence (${(s.setup || "").replace(/_/g, " ")})`
        : (s.reasons?.find(r => r.startsWith("Watch for")) || s.reasons?.[0] || "No setup forming");
      return { ticker, action, priority };
    })
    .sort((a, b) => WATCHLIST_PRIORITY_RANK[b.priority] - WATCHLIST_PRIORITY_RANK[a.priority]);
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
    watchlist: buildWatchlist(),
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
  msg += `SP500: $${markets.spx.price?.toLocaleString()} (${markets.spx.change > 0 ? "+" : ""}${markets.spx.change ?? 0}%) — <b>${markets.spx.bias}</b>\n\n`;

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
      "/plan — full daily plan with entries\n/btc — BTC signal + entry\n/gold — Gold signal + entry\n/spx — SP500 signal\n/signals — refresh all signals\n/daily — price summary"
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

  if (cmds[text]) { await cmds[text](); return; }

  // Anything else goes to JARVIS proper — same brain, same tools as the web dashboard's
  // chat, so "report/recommend/approve/search" all work as a real conversation, not a menu.
  await handleTelegramFreeform(chatId, message.text);
}

const telegramHistory = new Map(); // chatId -> recent {role, content} turns, same shape as web chat history
const TELEGRAM_HISTORY_MAX = 12;

async function handleTelegramFreeform(chatId, text) {
  const history = telegramHistory.get(chatId) || [];
  try {
    const { text: reply } = await askClaude(text, history);
    const safeReply = reply || "No reply from AI — check API key.";
    history.push({ role: "user", content: text }, { role: "assistant", content: safeReply });
    telegramHistory.set(chatId, history.slice(-TELEGRAM_HISTORY_MAX));
    await sendTelegram(chatId, safeReply);
  } catch (e) {
    await sendTelegram(chatId, "JARVIS error: " + (e?.message || "unknown"));
  }
}

let lastUpdateId = 0;
let telegramPollingStarted = false;
function ensureTelegramPolling() {
  if (telegramPollingStarted || !TELEGRAM_TOKEN) return;
  telegramPollingStarted = true;
  setInterval(pollTelegram, 3000);
  console.log("[telegram] Polling started");
}

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
app.post("/api/shutdown", requireLocalOnly, (_, res) => {
  res.json({ ok: true });
  console.log("[server] Shutdown requested from dashboard");
  setTimeout(() => process.exit(0), 400);
});
app.get("/api/health",  (_, res) => res.json({ ok: true, version: 9, ts: Date.now(), healer: autohealer.getStatus() }));
app.get("/api/signals",        (_, res) => res.json(signalCache));
app.get("/api/signal-history", (_, res) => res.json({ history: signalHistory.slice(0, 50) }));
// Latest parallel_analysis.py run. Served from disk rather than held in memory:
// the analysis is produced by a separate process on its own schedule, so the
// server must report whatever is currently on disk, including nothing at all.
// The full fact pack is several hundred KB, so it is only included on request.
const ANALYSIS_FILE = require("path").join(__dirname, "..", "tasks", "analysis", "latest.json");

// This route serves TWO different things on purpose, because two consumers ask for
// "the analysis" and mean different reports:
//
//   verdict/actions/blindSpots  the deep parallel_analysis.py run, from disk, hours
//                               or days old - what the /analysis skill reads
//   btc/gold/spx                the three live per-asset AI brains from
//                               refreshAnalysis(), seconds old - what the dashboard's
//                               AI Brain panel renders
//
// They used to be two separate app.get("/api/analysis") registrations. Express takes
// the FIRST match, so the second one - the brains - was unreachable dead code, and
// the dashboard's `[d.btc,d.gold,d.spx].filter(Boolean)` came back empty on every
// load. The panel had been rendering blank while three Claude calls per cycle
// produced output nobody could read. Merged rather than renamed so neither consumer
// has to change, and so a future duplicate route is a merge conflict here instead of
// a silent shadow.
app.get("/api/analysis", (req, res) => {
  // The brains are independent of the report file and must survive its absence.
  if (!analysisCache.updatedAt) refreshAnalysis();
  const brains = {
    btc:  analysisCache.btc,
    gold: analysisCache.gold,
    spx:  analysisCache.spx,
    brainsUpdatedAt: analysisCache.updatedAt,
    aiEnhanced: analysisCache.aiEnhanced ?? false,
  };
  try {
    if (!fs.existsSync(ANALYSIS_FILE)) {
      return res.json({ ...brains, available: false, reason: "no deep analysis has been run yet — run: python parallel_analysis.py" });
    }
    const report = JSON.parse(fs.readFileSync(ANALYSIS_FILE, "utf8"));
    const ageHours = (Date.now() - new Date(report.generatedAt).getTime()) / 3_600_000;
    res.json({
      ...brains,
      available:   true,
      generatedAt: report.generatedAt,
      ageHours:    parseFloat(ageHours.toFixed(1)),
      overall:     report.facts?.overall  ?? null,
      verdict:     report.synthesis?.verdict ?? null,
      actions:     report.synthesis?.actions ?? [],
      blindSpots:  report.synthesis?.blindSpots ?? [],
      facts:       req.query.full === "1" ? report.facts : undefined,
    });
  } catch (e) {
    // A corrupt report file must not take the live brains down with it.
    res.status(200).json({ ...brains, available: false, error: `could not read deep analysis: ${e.message}` });
  }
});

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

// Prices endpoint (live priceCache snapshot)
app.get("/api/prices", (_, res) => res.json(priceCache));

// Sentiment endpoint — Fear & Greed index + market sentiment
app.get("/api/sentiment", (_, res) => res.json(sentimentCache));

// Manual trade queue — bridge polls this to pick up trades queued from dashboard
let manualTradeQueue = [];
app.get("/api/manual-trade/pending",  (_, res) => res.json({ trades: manualTradeQueue }));
app.post("/api/manual-trade/queue",   (req, res) => {
  const trade = req.body;
  if (!trade || !trade.symbol) return res.status(400).json({ error: "symbol required" });
  trade.queuedAt = new Date().toISOString();
  manualTradeQueue.push(trade);
  console.log(`[manual] Trade queued: ${trade.symbol} ${trade.direction}`);
  res.json({ ok: true, queued: manualTradeQueue.length });
});
app.post("/api/manual-trade/clear",   (_, res) => { manualTradeQueue = []; res.json({ ok: true }); });
app.delete("/api/manual-trade/:idx",  (req, res) => {
  const idx = parseInt(req.params.idx, 10);
  if (isNaN(idx) || idx < 0 || idx >= manualTradeQueue.length) return res.status(400).json({ error: "invalid index" });
  manualTradeQueue.splice(idx, 1);
  res.json({ ok: true, remaining: manualTradeQueue.length });
});

// Native D1/H4/H1 bars pushed up by mt5_bridge.py for the symbols it actually
// trades. Validated hard on the way in: a payload that fails is rejected outright
// rather than stored partially, because a short or ragged series does not produce a
// missing signal — it produces a confident-looking signal computed from garbage.
// Per-asset, so one bad symbol never blocks the other two.
app.post("/api/mt5/candles", requireLocalOnly, (req, res) => {
  const assets = req.body?.assets;
  if (!assets || typeof assets !== "object") {
    return res.status(400).json({ error: "assets object required" });
  }
  const account  = typeof req.body?.account === "string" ? req.body.account : "default";
  const accepted = {};
  const rejected = {};
  // Which assets had no usable MT5 bars before this payload. Signals only recompute
  // on a 30-minute cron, so without this an asset could report activeSource "mt5"
  // while its cached signal was still built from Yahoo bars — different instrument,
  // different levels. That gap is how ticket #1682651222 got opened.
  const sourceWasYahoo = {};
  for (const assetKey of Object.values(ASSET_KEY_BY_TICKER)) {
    sourceWasYahoo[assetKey] = !mt5BarsFor(assetKey);
  }

  for (const [ticker, payload] of Object.entries(assets)) {
    const assetKey = ASSET_KEY_BY_TICKER[ticker];
    if (!assetKey) { rejected[ticker] = "unknown ticker"; continue; }

    const symbol = typeof payload?.symbol === "string" && payload.symbol.trim()
      ? payload.symbol.trim() : null;
    if (!symbol) { rejected[ticker] = "missing broker symbol"; continue; }

    const daily = sanitizeBars(payload?.bars?.d1, MT5_MIN_BARS.d1);
    if (!daily) {
      rejected[ticker] = `daily series unusable or under ${MT5_MIN_BARS.d1} bars`;
      continue;
    }

    mt5CandleCache[assetKey] = {
      symbol,
      account,
      bars: {
        d1: daily,
        h4: sanitizeBars(payload?.bars?.h4, MT5_MIN_BARS.h4),
        h1: sanitizeBars(payload?.bars?.h1, MT5_MIN_BARS.h1),
      },
      receivedAt: new Date().toISOString(),
    };
    accepted[assetKey] = {
      symbol,
      d1: daily.closes.length,
      h4: mt5CandleCache[assetKey].bars.h4?.closes.length ?? 0,
      h1: mt5CandleCache[assetKey].bars.h1?.closes.length ?? 0,
    };
  }

  if (Object.keys(rejected).length) {
    console.warn(`[mt5-candles] rejected from ${account}:`, rejected);
  }
  if (Object.keys(accepted).length) {
    console.log(`[mt5-candles] accepted from ${account}:`,
      Object.entries(accepted).map(([k, v]) => `${k}=${v.symbol}(${v.d1}/${v.h4}/${v.h1})`).join(" "));
  }

  // Recompute immediately when an asset crosses from Yahoo to MT5, rather than
  // leaving a stale futures-derived signal live for the rest of the cron interval.
  // Fires only on the transition — steady-state pushes every 5 minutes do not
  // trigger it, so this cannot become a refresh storm.
  const flippedToMt5 = Object.keys(accepted).filter(k => sourceWasYahoo[k] && mt5BarsFor(k));
  if (flippedToMt5.length && !signalRefreshInFlight) {
    signalRefreshInFlight = true;
    console.log(`[mt5-candles] ${flippedToMt5.join(", ")} switched yahoo -> mt5, recomputing signals now`);
    // Deliberately not awaited: the bridge is waiting on this response and a signal
    // refresh takes ~15s. Errors are swallowed into a log because a failed refresh
    // must not fail the candle ingest — the bars are already stored either way.
    refreshSignals()
      .catch(e => console.error("[mt5-candles] post-ingest refresh failed:", e.message))
      .finally(() => { signalRefreshInFlight = false; });
  }

  res.json({ ok: true, accepted, rejected });
});

// What the signal engine is currently reading per asset, and why. Exists because
// "which instrument produced this signal" was previously unanswerable from outside
// the process — the dashboard showed Gold levels with no way to tell they came from
// a futures series rather than the spot symbol being filled.
app.get("/api/mt5/candles", (_, res) => {
  const sources = {};
  for (const [ticker, assetKey] of Object.entries(ASSET_KEY_BY_TICKER)) {
    const entry = mt5CandleCache[assetKey];
    const live  = mt5BarsFor(assetKey);
    sources[assetKey] = {
      yahooTicker: ticker,
      brokerSymbol: entry?.symbol ?? null,
      receivedAt: entry?.receivedAt ?? null,
      ageMs: entry ? Date.now() - new Date(entry.receivedAt).getTime() : null,
      bars: entry ? {
        d1: entry.bars.d1?.closes.length ?? 0,
        h4: entry.bars.h4?.closes.length ?? 0,
        h1: entry.bars.h1?.closes.length ?? 0,
      } : null,
      inUse: Boolean(live),
      activeSource: live ? "mt5" : "yahoo",
    };
  }
  res.json({ sources, maxAgeMs: MT5_CANDLE_MAX_AGE_MS, minBars: MT5_MIN_BARS });
});

// MT5 bridge endpoints — each bridge instance tags its posts with its own account
// (ACCOUNT_TAG env var in mt5_bridge.py) so running two bridges doesn't stomp on
// each other's reported positions/risk state.
function recomputeMt5Positions() {
  mt5Positions = Object.entries(mt5PositionsByAccount).flatMap(([account, positions]) =>
    positions.map(p => ({ ...p, account }))
  );
}

// Every bridge loop posts here once per poll (even with zero open positions), so this
// doubles as the connectivity heartbeat used by /api/checksystem — a bridge with no
// open trades should never be reported as "offline" just because mt5Positions is empty.
let mt5LastSeenByAccount = {}; // account tag -> ISO timestamp of last report
const MT5_HEARTBEAT_STALE_MS = 150 * 1000; // 2.5x the default 60s poll interval

// Per-account health check, batch-friendly: 200 while connected (or never yet seen —
// that's not "down", just not started), 503 once a previously-connected bridge goes
// stale. tasks/watchdog.bat polls this per account and restarts only the stale one.
// "Never connected yet" is only tolerated for a grace period after the server itself
// started — long enough for a cold-boot MT5 launch + the bridge's own retry loop
// (6 attempts, 15s apart = ~90s) to succeed. Past that, an account that has STILL never
// reported in is exactly as broken as one that connected once and went stale — this is
// what closes the gap a real reboot test found: a bridge that fails its very first
// connection attempt used to be invisible to this check forever, since neither "stale"
// nor "never connected" fired past that point.
const MT5_NEVER_CONNECTED_GRACE_MS = 5 * 60 * 1000;

app.get("/api/mt5/health", (req, res) => {
  const account  = req.query.account || "default";
  const lastSeen = mt5LastSeenByAccount[account];
  if (!lastSeen) {
    const serverAgeMs = process.uptime() * 1000;
    if (serverAgeMs < MT5_NEVER_CONNECTED_GRACE_MS) {
      return res.status(200).json({ connected: null, reason: "never connected yet — within startup grace period" });
    }
    return res.status(503).json({ connected: false, reason: `never connected — server has been up ${Math.round(serverAgeMs / 1000)}s, past the startup grace period` });
  }
  const ageMs     = Date.now() - new Date(lastSeen).getTime();
  const connected = ageMs < MT5_HEARTBEAT_STALE_MS;
  res.status(connected ? 200 : 503).json({ connected, ageMs, lastSeen });
});

app.get("/api/mt5/positions",  (_, res) => res.json({ positions: mt5Positions, byAccount: mt5PositionsByAccount }));
app.post("/api/mt5/positions", (req, res) => {
  const account = req.body?.account || "default";
  mt5PositionsByAccount[account] = req.body?.positions ?? [];
  mt5LastSeenByAccount[account] = new Date().toISOString();
  recomputeMt5Positions();
  res.json({ ok: true, count: mt5Positions.length });
});

// MT5 terminal login — dashboard "Auto Trade" tab, one form per account.
// Credentials never touch a log line or an error message. This only accepts
// requests from the machine's own loopback address: password is submitted from
// a browser tab, but that tab must be running on this machine (e.g. inside the
// VPS's own RDP session), never relayed from a remote browser over the network.
const MT5_TERMINALS = {
  A: { path: "C:\\Program Files\\MetaTrader 5\\terminal64.exe", portable: false },
  B: { path: "C:\\MT5-B\\terminal64.exe",                       portable: true  },
};

app.post("/api/mt5/login", (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLocal) {
    return res.status(403).json({ ok: false, error: "This only accepts requests from the server's own machine — open the dashboard in a browser on the VPS itself." });
  }

  const { account, login, password, server } = req.body || {};
  const terminal = MT5_TERMINALS[account];
  if (!terminal) return res.status(400).json({ ok: false, error: "account must be 'A' or 'B'" });
  if (!login || !password || !server) return res.status(400).json({ ok: false, error: "login, password, and server are required" });

  const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
  const child = require("child_process").spawn(PYTHON_BIN, [path.join(__dirname, "..", "mt5_login_helper.py")], {
    cwd: path.join(__dirname, "..")
  });

  // Hard ceiling independent of the Python-side timeouts — a hung child process
  // must never leave this request (or the process itself) hanging indefinitely.
  const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
  let responded = false;

  let out = "";
  child.stdout.on("data", d => { out += d.toString(); });
  child.on("error", () => {
    if (responded) return;
    responded = true;
    clearTimeout(killTimer);
    res.status(500).json({ ok: false, error: "could not start login helper" });
  });
  child.on("close", () => {
    if (responded) return;
    responded = true;
    clearTimeout(killTimer);
    try {
      const lastLine = out.trim().split("\n").pop();
      res.json(JSON.parse(lastLine));
    } catch {
      res.status(500).json({ ok: false, error: "login helper produced no usable result (or timed out)" });
    }
  });

  child.stdin.write(JSON.stringify({ login, password, server, terminalPath: terminal.path, portable: terminal.portable }));
  child.stdin.end();
});

// Risk status endpoints
let riskStatusByAccount = {}; // account tag -> {dailyPnl, consecutiveLosses, halted, haltReason}
function recomputeRiskStatus() {
  const accounts = Object.values(riskStatusByAccount);
  if (!accounts.length) return;
  const halted = accounts.filter(a => a.halted);
  riskStatus = {
    dailyPnl: parseFloat(accounts.reduce((s, a) => s + (a.dailyPnl || 0), 0).toFixed(2)),
    consecutiveLosses: Math.max(...accounts.map(a => a.consecutiveLosses || 0)),
    halted: halted.length > 0,
    haltReason: halted.map(a => a.haltReason).filter(Boolean).join(" | "),
    accounts: riskStatusByAccount
  };
}

app.get("/api/risk-status",  (_, res) => res.json(riskStatus));
app.post("/api/risk-status", (req, res) => {
  const account = req.body?.account || "default";
  riskStatusByAccount[account] = { ...riskStatusByAccount[account], ...req.body };
  recomputeRiskStatus();
  if (riskStatus.halted) {
    console.log(`[risk] CIRCUIT BREAKER ACTIVE: ${riskStatus.haltReason}`);
  }
  res.json({ ok: true });
});

// ── Remote trading control ────────────────────────────────────
// Until now every channel between the dashboard and the bridge ran one way:
// the bridge reported positions and its own circuit-breaker state upward, and
// nothing could reach down to tell it to stop. The only "control" on the Auto
// Trade page was "Stop Server", which kills the server, closes nothing, and
// leaves live positions running with no one watching them. That is the opposite
// of a kill switch.
//
// This is the downward channel: the dashboard sets a halt, the bridge reads it
// once per poll and stops OPENING trades. It deliberately does not touch open
// positions — flattening places market orders and is a separate, far more
// dangerous action that deserves its own explicit confirmation, not a shared
// endpoint where a typo could liquidate an account.
//
// Persisted to disk on purpose: a halt is a safety decision, and a server
// restart (the watchdog does this on any crash) must never silently resume
// trading behind your back. Fail-safe means fail-halted.
const TRADING_CONTROL_FILE = path.join(__dirname, "trading_control.json");

let tradingControl = { halted: false, reason: "", setAt: null, setBy: null };

function loadTradingControl() {
  try {
    if (!fs.existsSync(TRADING_CONTROL_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(TRADING_CONTROL_FILE, "utf8"));
    if (saved && typeof saved.halted === "boolean") {
      tradingControl = {
        halted: saved.halted,
        reason: typeof saved.reason === "string" ? saved.reason : "",
        setAt:  saved.setAt  || null,
        setBy:  saved.setBy  || null,
      };
      if (tradingControl.halted) {
        console.log(`[control] Restored HALT from disk: ${tradingControl.reason || "no reason given"}`);
      }
    }
  } catch (e) {
    // A corrupt control file must not decide to let trading run. Halt and say so.
    tradingControl = { halted: true, reason: `control file unreadable (${e.message}) — halted for safety`, setAt: new Date().toISOString(), setBy: "system" };
    console.error("[control] trading_control.json unreadable — defaulting to HALTED");
  }
}

function saveTradingControl() {
  try {
    fs.writeFileSync(TRADING_CONTROL_FILE, JSON.stringify(tradingControl, null, 2));
  } catch (e) {
    console.error(`[control] Could not persist trading control: ${e.message}`);
  }
}

loadTradingControl();

// The bridge polls this every cycle. Kept in the no-login allowlist below because
// the bridge has no browser session.
app.get("/api/mt5/control", (_, res) => res.json(tradingControl));

// ── Strategy settings API ─────────────────────────────────────
// GET is public because the bridge polls it and has no browser session; POST
// requires one, since raising the trade cap or lowering the confidence gate makes
// the system trade more, and this server is reachable from the internet.
app.get("/api/strategy-settings", (_, res) => {
  // settingsError non-null means these values are the built-in defaults, NOT the
  // saved file. Surfaced because the difference is invisible in the numbers alone
  // and it changes live position sizing.
  res.json({
    ...strategySettings,
    limits: STRATEGY_LIMITS,
    settingsError: strategySettingsError,
  });
});

app.post("/api/strategy-settings", (req, res) => {
  const incoming = req.body || {};
  const applied = {};
  const rejected = [];

  for (const name of Object.keys(STRATEGY_LIMITS)) {
    if (incoming[name] === undefined) continue;
    const clamped = clampStrategyValue(name, incoming[name]);
    if (clamped === null) {
      rejected.push(`${name} must be a number`);
      continue;
    }
    // Say so when a value was clamped. Silently "accepting" 200 and storing 50
    // would leave you believing a limit you do not have.
    if (Number(incoming[name]) !== clamped) {
      rejected.push(`${name} clamped to ${clamped} (allowed ${STRATEGY_LIMITS[name].min}-${STRATEGY_LIMITS[name].max})`);
    }
    strategySettings[name] = clamped;
    applied[name] = clamped;
  }

  if (incoming.minStrength !== undefined) {
    const wanted = String(incoming.minStrength).toUpperCase();
    if (STRENGTH_LEVELS.includes(wanted)) {
      strategySettings.minStrength = wanted;
      applied.minStrength = wanted;
    } else {
      rejected.push(`minStrength must be one of ${STRENGTH_LEVELS.join(", ")}`);
    }
  }

  if (Object.keys(applied).length === 0) {
    return res.status(400).json({ ok: false, error: "No valid settings supplied", rejected });
  }

  strategySettings.updatedAt = new Date().toISOString();
  strategySettings.updatedBy = "dashboard";
  saveStrategySettings();
  console.log(`[strategy] Updated from dashboard: ${JSON.stringify(applied)}`);
  res.json({ ok: true, settings: strategySettings, applied, notes: rejected });
});

app.post("/api/mt5/control", (req, res) => {
  const { halted, reason } = req.body || {};
  if (typeof halted !== "boolean") {
    return res.status(400).json({ ok: false, error: "halted must be true or false" });
  }
  tradingControl = {
    halted,
    reason: typeof reason === "string" ? reason.slice(0, 200) : "",
    setAt:  new Date().toISOString(),
    setBy:  "dashboard",
  };
  saveTradingControl();
  console.log(`[control] Trading ${halted ? "HALTED" : "RESUMED"} from dashboard${tradingControl.reason ? ` — ${tradingControl.reason}` : ""}`);
  res.json({ ok: true, control: tradingControl });
});

// ── /api/settings — API keys & Telegram config ─────────────────
// Values are masked on read and written only to gitignored files (keys.env, apikey.txt).
app.get("/api/settings", (_, res) => {
  const env = readKeysEnv();
  const known = new Set(["TV_USERNAME", "TV_PASSWORD", "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "UW_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  res.json({
    anthropicKey:   { configured: !!ANTHROPIC_API_KEY, preview: maskKey(ANTHROPIC_API_KEY) },
    telegramToken:  { configured: !!TELEGRAM_TOKEN,     preview: maskKey(TELEGRAM_TOKEN) },
    telegramChatId: TELEGRAM_CHAT_ID || "",
    openaiKey:      { configured: !!OPENAI_API_KEY,     preview: maskKey(OPENAI_API_KEY) },
    uwKey:          { configured: !!UW_API_KEY,         preview: maskKey(UW_API_KEY) },
    custom: Object.entries(env)
      .filter(([k]) => !known.has(k))
      .map(([k, v]) => ({ key: k, preview: maskKey(v) })),
  });
});

app.post("/api/settings", requireLocalOnly, (req, res) => {
  const { anthropicKey, telegramToken, telegramChatId, openaiKey, uwKey, custom } = req.body || {};
  const updates = {};

  if (typeof telegramToken === "string" && telegramToken.trim())   { TELEGRAM_TOKEN   = sanitizeEnvValue(telegramToken);   updates.TELEGRAM_TOKEN   = TELEGRAM_TOKEN; ensureTelegramPolling(); }
  if (typeof telegramChatId === "string" && telegramChatId.trim()) { TELEGRAM_CHAT_ID = sanitizeEnvValue(telegramChatId); updates.TELEGRAM_CHAT_ID = TELEGRAM_CHAT_ID; knownChatIds.add(TELEGRAM_CHAT_ID); }
  if (typeof uwKey === "string" && uwKey.trim())                   { UW_API_KEY       = sanitizeEnvValue(uwKey);          updates.UW_API_KEY       = UW_API_KEY; }
  if (typeof openaiKey === "string" && openaiKey.trim())           { OPENAI_API_KEY   = sanitizeEnvValue(openaiKey);      updates.OPENAI_API_KEY   = OPENAI_API_KEY; }

  if (Array.isArray(custom)) {
    for (const entry of custom) {
      const key = entry?.key, value = entry?.value;
      if (!key || typeof value !== "string" || !value.trim()) continue;
      const safeKey = String(key).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (safeKey) updates[safeKey] = sanitizeEnvValue(value);
    }
  }

  if (Object.keys(updates).length) writeKeysEnv(updates);

  if (typeof anthropicKey === "string" && anthropicKey.trim()) {
    try {
      fs.writeFileSync(APIKEY_PATH, sanitizeEnvValue(anthropicKey), "utf8");
      reloadAnthropicClient();
    } catch (e) {
      return res.status(500).json({ error: "Failed to save Anthropic key: " + e.message });
    }
  }

  res.json({ ok: true });
});

// Performance stats — actual win rate per setup + confidence calibration
app.get("/api/stats/by-setup", (_, res) => {
  const closed = tradeJournal.filter(t => t.status === "CLOSED" && t.pnl !== null);
  if (!closed.length) return res.json({ noData: true, message: "No closed trades yet" });

  // Group by setup
  const bySetup = {};
  for (const t of closed) {
    const key = t.setup || "UNKNOWN";
    if (!bySetup[key]) bySetup[key] = {
      setup: key, trades: 0, wins: 0, losses: 0, totalPnl: 0,
      totalRR: 0, rrTrades: 0, totalRealizedR: 0, realizedRTrades: 0,
    };
    const s = bySetup[key];
    s.trades++;
    if (t.pnl > 0) s.wins++; else s.losses++;
    s.totalPnl  += t.pnl;

    // Derive both figures from the row's own prices rather than trusting the
    // stored rr. Journal rows written before this change hold the signal's
    // planned R:R, which describes a trade that was never taken — reading
    // through the prices corrects them without rewriting protected history.
    const impliedRR = impliedRRFromPrices(t.entry, t.sl, t.tp);
    if (impliedRR !== null) { s.totalRR += impliedRR; s.rrTrades++; }

    const realizedR = realizedRFromPrices(t.direction, t.entry, t.sl, t.closePrice);
    if (realizedR !== null) { s.totalRealizedR += realizedR; s.realizedRTrades++; }
  }
  const setupStats = Object.values(bySetup).map(s => ({
    ...s,
    winRate:  s.trades > 0 ? parseFloat((s.wins / s.trades * 100).toFixed(1)) : 0,
    avgPnl:   parseFloat((s.totalPnl / s.trades).toFixed(2)),
    // What the setup aimed for...
    avgRR:    s.rrTrades > 0 ? parseFloat((s.totalRR / s.rrTrades).toFixed(1)) : null,
    // ...and what it actually delivered. A setup whose avgRR is high while
    // avgRealizedR is negative is losing money on paper-good geometry.
    avgRealizedR: s.realizedRTrades > 0
      ? parseFloat((s.totalRealizedR / s.realizedRTrades).toFixed(2))
      : null,
  })).sort((a, b) => b.winRate - a.winRate);

  // Confidence calibration — do higher confidence scores actually win more?
  const tiers = [
    { label: "95-100%", min: 95, max: 100 },
    { label: "85-94%",  min: 85, max: 94  },
    { label: "75-84%",  min: 75, max: 84  },
    { label: "65-74%",  min: 65, max: 74  },
    { label: "<65%",    min: 0,  max: 64  }
  ];
  const calibration = tiers.map(tier => {
    const group = closed.filter(t => (t.confidence ?? 0) >= tier.min && (t.confidence ?? 0) <= tier.max);
    const wins  = group.filter(t => t.pnl > 0).length;
    return {
      tier:     tier.label,
      trades:   group.length,
      wins,
      winRate:  group.length > 0 ? parseFloat((wins / group.length * 100).toFixed(1)) : null,
      avgPnl:   group.length > 0 ? parseFloat((group.reduce((s,t) => s + t.pnl, 0) / group.length).toFixed(2)) : null
    };
  }).filter(t => t.trades > 0);

  res.json({ totalClosed: closed.length, setupStats, calibration });
});

// The second app.get("/api/analysis") lived here and was never reachable — Express
// had already matched the one at the top of this file. Its payload (the three live
// AI brains) is now folded into that route; see the comment there.

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const { text, video } = await askClaude(message, Array.isArray(history) ? history : []);
    if (!text) return res.json({ reply: "No reply from AI — check API key." });
    res.json({ reply: text, video });
  } catch (e) {
    const msg = e?.message || e?.toString() || "Unknown error";
    console.error("[chat] error:", msg);
    res.status(500).json({ error: msg });
  }
});

// ── /api/tts — high-quality cloud voice for JARVIS (requires an OpenAI key in Settings) ──
app.post("/api/tts", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  if (!OPENAI_API_KEY) return res.status(404).json({ error: "No OpenAI key configured — using browser voice." });
  try {
    const r = await axios.post(
      "https://api.openai.com/v1/audio/speech",
      { model: "gpt-4o-mini-tts", voice: "onyx", input: String(text).slice(0, 2000), response_format: "mp3" },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 30000 }
    );
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(r.data));
  } catch (e) {
    console.error("[tts] error:", e.message);
    res.status(502).json({ error: "TTS request failed: " + e.message });
  }
});

// ── /api/youtube-search — find a video for JARVIS to pop up (requires a YouTube key in Settings) ──
async function searchYouTube(query) {
  const results = await YouTube.search(query, { limit: 5, type: "video", safeSearch: true });
  return results.map(v => ({
    videoId: v.id,
    title: v.title,
    channel: v.channel?.name || "",
    thumbnail: v.thumbnail?.url || "",
  }));
}

app.get("/api/youtube-search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "q required" });
  try {
    res.json({ results: await searchYouTube(q) });
  } catch (e) {
    console.error("[youtube] search error:", e.message);
    res.status(502).json({ error: "YouTube search failed: " + e.message });
  }
});

// ── V12 Feature Endpoints ─────────────────────────────────────

// MT5 bridge notifies server when a trade is opened
function getSignalKeyForSymbol(symbol) {
  if (!symbol) return null;
  const s = symbol.toUpperCase();
  if (s.includes("BTC") || s.includes("BITCOIN")) return "btc";
  if (s.includes("XAU") || s.includes("GOLD"))    return "gold";
  if (s.includes("SPX") || s.includes("SPY") || s.includes("US500") || s.includes("SP500")) return "spx";
  return null;
}

// R:R implied by a trade's OWN prices. The journal used to copy the signal's
// planned rr into the row next to the broker's fill prices, so the number and
// the prices beside it described different trades — the only real trade stored
// rr 2.5 while its own entry/sl/tp imply 6.57. That gap is the mechanism behind
// the "rr-artifact" inflation in the performance figures.
function impliedRRFromPrices(entryPrice, stopPrice, targetPrice) {
  const prices = [entryPrice, stopPrice, targetPrice];
  if (!prices.every(p => typeof p === "number" && Number.isFinite(p))) return null;
  const riskDistance = Math.abs(entryPrice - stopPrice);
  if (riskDistance === 0) return null;
  return parseFloat((Math.abs(targetPrice - entryPrice) / riskDistance).toFixed(2));
}

// Realized R for a closed trade: how far price actually travelled, in units of
// the risk that was on the table. Direction-signed, so a BUY closed at its stop
// is exactly -1.00R rather than a positive "R:R" the trade never earned.
function realizedRFromPrices(direction, entryPrice, stopPrice, closePrice) {
  const prices = [entryPrice, stopPrice, closePrice];
  if (!prices.every(p => typeof p === "number" && Number.isFinite(p))) return null;
  const riskDistance = Math.abs(entryPrice - stopPrice);
  if (riskDistance === 0) return null;
  const isShort  = String(direction || "").toUpperCase().startsWith("S");
  const movement = isShort ? entryPrice - closePrice : closePrice - entryPrice;
  return parseFloat((movement / riskDistance).toFixed(2));
}

app.post("/api/trade-opened", async (req, res) => {
  const trade = req.body;
  if (!trade || !trade.ticket) return res.status(400).json({ error: "invalid trade data" });
  console.log(`[trade] Opened: ${trade.type} ${trade.symbol} @ $${trade.price} #${trade.ticket}`);

  // Capture signal context at the moment the trade opens
  const sigKey = getSignalKeyForSymbol(trade.symbol);
  const sig    = sigKey ? signalCache[sigKey] : null;
  const signalContext = sig ? {
    setup:      sig.setup,
    confidence: sig.confidence,
    strength:   sig.strength,
    regime:     sig.regime,
    atr:        sig.atr
  } : null;

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
      // Which broker account owns this trade. The bridge has always sent it
      // (mt5_bridge.py:863); this entry used to drop it, which is why every
      // journal entry written before now is unattributable — and why closes
      // could only be matched on a ticket id that is unique per account, not
      // across the fleet.
      account:   trade.account || "default",
      openTime:  new Date().toISOString(),
      closeTime: null,
      closePrice: null,
      pnl:       null,
      status:    "OPEN",
      ...signalContext,
      // rr describes THIS row's prices; plannedRr preserves what the signal
      // intended, so a fill that slipped away from the plan stays visible
      // instead of overwriting the record of it.
      rr:        impliedRRFromPrices(trade.price, trade.sl, trade.tp),
      plannedRr: sig ? sig.rr : null,
      commentary
    };
    tradeJournal.unshift(entry);
    if (tradeJournal.length > 200) tradeJournal = tradeJournal.slice(0, 200);
    saveJournal();
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
  const { ticket, pnl, closePrice, closeTime, account } = req.body;
  if (!ticket) return res.status(400).json({ error: "ticket required" });
  // Ticket ids are unique per ACCOUNT, not across the fleet (mt5_bridge.py:1384),
  // and accounts A, B and the VPS all post into this one journal. Prefer the exact
  // pair. The ticket-only fallback is deliberately restricted to entries carrying
  // no account — every entry written before this change — so a close can never be
  // applied to a different account's trade, while old entries still reconcile.
  const trade = tradeJournal.find(t => t.ticket === ticket && t.account === account)
             ?? tradeJournal.find(t => t.ticket === ticket && !t.account);
  if (trade) {
    // Stamp legacy entries so the next close matches on the exact pair.
    if (!trade.account && account) trade.account = account;
    trade.status     = "CLOSED";
    trade.pnl        = pnl       ?? null;
    trade.closePrice = closePrice ?? null;
    trade.closeTime  = closeTime  ?? new Date().toISOString();
    saveJournal();
    // Feed outcome to self-learning engine
    const outcomeKnown = trade.pnl !== null;
    // Same rule as updateLearning() at line 319 — a scratch counts as a loss in
    // both stores, so learning.json and SQLite can never disagree on a trade.
    const outcome = outcomeKnown ? (trade.pnl > 0 ? "WIN" : "LOSS") : null;
    if (trade.setup && outcomeKnown) {
      updateLearning(trade.setup, trade.pnl);
      const healthAlerts = checkSetupHealth();
      if (healthAlerts.length > 0) {
        riskStatus.setupAlerts = healthAlerts;
      }
      // db.js counts on uppercase; lowercase silently incremented neither counter.
      db.updateLearning(trade.setup, outcome, trade.pnl);
    } else if (!outcomeKnown) {
      console.warn(`[trade] #${ticket} closed with no P&L — recorded, not scored`);
    }
    // insertTrade reads stop/target/size/outcome/closed_at; the journal entry
    // carries sl/tp/volume/status/closeTime. Mapped explicitly rather than
    // renaming journal fields, which would break every existing journal.json.
    db.insertTrade({
      ...trade,
      stop:      trade.sl,
      target:    trade.tp,
      size:      trade.volume,
      outcome,
      closed_at: trade.closeTime,
    });
  }
  console.log(`[trade] Closed: #${ticket}  P&L $${pnl}`);
  res.json({ ok: true });
});

// Trade journal with optional filtering
app.get("/api/journal", (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const symbol  = (req.query.symbol  || "").toUpperCase();
  const outcome = (req.query.outcome || "").toUpperCase();
  let entries = tradeJournal;
  if (symbol)  entries = entries.filter(t => (t.symbol  || "").toUpperCase() === symbol);
  if (outcome) entries = entries.filter(t => (t.outcome || "").toUpperCase() === outcome);
  res.json({ journal: entries.slice(0, limit) });
});

// ── /api/growth — P&L by real calendar period ─────────────────
// The only performance view before this was a prose weekly AI report and a set of
// all-time totals, which cannot answer "am I up this month" or "was last week
// worse than the one before". Buckets closed trades by actual calendar boundaries
// rather than rolling windows, because "this month" means the month, not 30 days.
//
// Reads the journal, which caps at 200 entries — the equity curve is therefore the
// last 200 closed trades, not all history. Stated in the payload rather than
// quietly implied, so nobody reads a truncated curve as a complete one.
const GROWTH_PERIOD_KEYS = {
  // ISO week, so weeks start Monday and do not drift across year boundaries.
  week: (d) => {
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = tmp.getUTCDay() || 7;              // Sunday = 7, not 0
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);    // shift to the Thursday of this week
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
  },
  day:   (d) => d.toISOString().slice(0, 10),
  month: (d) => d.toISOString().slice(0, 7),
  year:  (d) => String(d.getUTCFullYear()),
};

function summariseGrowth(closedTrades, periodName) {
  const keyOf = GROWTH_PERIOD_KEYS[periodName];
  const buckets = new Map();

  for (const trade of closedTrades) {
    const key = keyOf(new Date(trade.closeTime));
    if (!buckets.has(key)) buckets.set(key, { period: key, pnl: 0, trades: 0, wins: 0, losses: 0 });
    const bucket = buckets.get(key);
    bucket.pnl += trade.pnl;
    bucket.trades += 1;
    if (trade.pnl > 0) bucket.wins += 1;
    else if (trade.pnl < 0) bucket.losses += 1;
  }

  return [...buckets.values()]
    .map(b => ({
      ...b,
      pnl: Math.round(b.pnl * 100) / 100,
      // Breakeven trades count in `trades` but belong to neither side, so the rate
      // is wins over decided trades, not over everything.
      winRate: (b.wins + b.losses) > 0 ? Math.round((b.wins / (b.wins + b.losses)) * 100) : null,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

app.get("/api/growth", (_, res) => {
  try {
    const closed = (tradeJournal || [])
      .filter(t => t && t.status === "CLOSED" && typeof t.pnl === "number" && t.closeTime)
      .sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));

    let running = 0;
    const equityCurve = closed.map(t => {
      running += t.pnl;
      return {
        at: t.closeTime,
        pnl: Math.round(t.pnl * 100) / 100,
        cumulative: Math.round(running * 100) / 100,
        symbol: t.symbol || null,
      };
    });

    // Peak-to-trough on realised P&L only — open positions are not in here.
    let peak = 0, maxDrawdown = 0;
    for (const point of equityCurve) {
      if (point.cumulative > peak) peak = point.cumulative;
      const drawdown = peak - point.cumulative;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const wins   = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl < 0);
    const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    res.json({
      generatedAt: new Date().toISOString(),
      hasData: closed.length > 0,
      journalCap: 200,
      truncated: (tradeJournal || []).length >= 200,
      totals: {
        trades: closed.length,
        netPnl: Math.round(running * 100) / 100,
        wins: wins.length,
        losses: losses.length,
        winRate: (wins.length + losses.length) > 0
          ? Math.round((wins.length / (wins.length + losses.length)) * 100) : null,
        avgWin:  wins.length   ? Math.round((grossWin / wins.length) * 100) / 100 : null,
        avgLoss: losses.length ? Math.round((grossLoss / losses.length) * 100) / 100 : null,
        profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
        maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      },
      day:   summariseGrowth(closed, "day"),
      week:  summariseGrowth(closed, "week"),
      month: summariseGrowth(closed, "month"),
      year:  summariseGrowth(closed, "year"),
      equityCurve,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Self-learning state
app.get("/api/hermes", (_, res) => {
  try {
    res.json(hermes.getSnapshot(signalCache, priceCache));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/learning", (_, res) => {
  try {
    const summary = {};
    for (const [setup, s] of Object.entries(learning.setupStats)) {
      const total = s.wins + s.losses;
      summary[setup] = {
        wins: s.wins, losses: s.losses, total,
        winRate: total > 0 ? parseFloat((s.wins / total * 100).toFixed(1)) : null,
        totalPnl: s.totalPnl,
        boost: getLearningBoost(setup),
        status: total < 5 ? "learning" : s.wins / total > 0.55 ? "boosted" : s.wins / total < 0.45 ? "penalised" : "neutral"
      };
    }
    res.json({ setupStats: summary, sessionCount: learning.sessionCount, updatedAt: learning.updatedAt });
  } catch (e) {
    res.json({ setupStats: {}, sessionCount: 0, updatedAt: null });
  }
});

app.post("/api/learning/reset", requireLocalOnly, (_, res) => {
  learning.setupStats = {};
  learning.updatedAt = new Date().toISOString();
  saveLearning();
  res.json({ ok: true, message: "Learning reset — all boosts cleared" });
});

// Deep system health check
app.get("/api/checksystem", (_, res) => {
  const closed = tradeJournal.filter(t => t.status === "CLOSED" && t.pnl !== null);
  const wins = closed.filter(t => t.pnl > 0).length;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const recentLosses = closed.slice(0, 5).filter(t => t.pnl < 0).length;

  // Equity curve health
  let equity = 10000;
  for (const t of [...closed].reverse()) {
    if (t.pnl > 0) equity += t.pnl; else equity += t.pnl;
  }

  // Setup health
  const setupHealth = {};
  for (const [setup, s] of Object.entries(learning.setupStats)) {
    const total = s.wins + s.losses;
    if (total >= 3) {
      const wr = s.wins / total;
      setupHealth[setup] = { wr: parseFloat((wr * 100).toFixed(1)), status: wr > 0.55 ? "GOOD" : wr < 0.4 ? "REVIEW" : "OK" };
    }
  }

  // Confidence calibration check
  const tiers = [
    { label: "65-74%", min: 65, max: 74 },
    { label: "75-84%", min: 75, max: 84 },
    { label: "85%+",   min: 85, max: 100 }
  ];
  const calibration = tiers.map(tier => {
    const group = closed.filter(t => (t.confidence ?? 0) >= tier.min && (t.confidence ?? 0) <= tier.max);
    const gWins = group.filter(t => t.pnl > 0).length;
    return { tier: tier.label, trades: group.length, winRate: group.length > 0 ? parseFloat((gWins / group.length * 100).toFixed(1)) : null };
  });

  // Proposal check
  let proposal = null;
  try {
    const pp = require("path").join(__dirname, "..", "tasks", "improvement_proposal.json");
    if (fs.existsSync(pp)) proposal = JSON.parse(fs.readFileSync(pp, "utf8"));
  } catch {}

  // MT5 bridge connectivity — based on last heartbeat per account, not open-position
  // count (a bridge with zero open trades is still connected and must not read OFFLINE).
  const now = Date.now();
  const mt5Accounts = Object.entries(mt5LastSeenByAccount).map(([account, lastSeen]) => {
    const ageMs = now - new Date(lastSeen).getTime();
    return { account, lastSeen, secondsAgo: Math.round(ageMs / 1000), connected: ageMs < MT5_HEARTBEAT_STALE_MS };
  });

  res.json({
    server:      { port: PORT, uptime: Math.round(process.uptime()), healthy: true },
    signals:     { btc: signalCache.btc?.signal, gold: signalCache.gold?.signal, spx: signalCache.spx?.signal, updatedAt: signalCache.updatedAt },
    risk:        riskStatus,
    mode:        { modeOverride: null },
    performance: { trades: closed.length, wins, winRate: closed.length > 0 ? parseFloat((wins / closed.length * 100).toFixed(1)) : null, totalPnl: parseFloat(totalPnl.toFixed(2)), recentLosses },
    learning:    { sessionCount: learning.sessionCount, setupsTracked: Object.keys(learning.setupStats).length, setupHealth },
    calibration,
    mt5:         { connected: mt5Accounts.some(a => a.connected), accounts: mt5Accounts },
    proposal:    proposal ? { worstSetup: proposal.worstSetup, winRate: proposal.winRate, generatedAt: proposal.generatedAt } : null
  });
});

// Setup health — which setups to prioritise or avoid
app.get("/api/setup-health", (_, res) => {
  res.json({ alerts: checkSetupHealth(), updatedAt: new Date().toISOString() });
});

// Daily plan — structured trade plan for today
app.get("/api/daily-plan", (_, res) => {
  const plan = {
    date:     new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    signals: {
      btc:  signalCache.btc  ? { signal: signalCache.btc.signal,  confidence: signalCache.btc.confidence,  entry: signalCache.btc.entry,  stop: signalCache.btc.stop,  target: signalCache.btc.target,  setup: signalCache.btc.setup,  regime: signalCache.btc.regime,  rr: signalCache.btc.rr  } : null,
      gold: signalCache.gold ? { signal: signalCache.gold.signal, confidence: signalCache.gold.confidence, entry: signalCache.gold.entry, stop: signalCache.gold.stop, target: signalCache.gold.target, setup: signalCache.gold.setup, regime: signalCache.gold.regime, rr: signalCache.gold.rr } : null,
      spx:  signalCache.spx  ? { signal: signalCache.spx.signal,  confidence: signalCache.spx.confidence,  entry: signalCache.spx.entry,  stop: signalCache.spx.stop,  target: signalCache.spx.target,  setup: signalCache.spx.setup,  regime: signalCache.spx.regime,  rr: signalCache.spx.rr  } : null,
    },
    prices:   { btc: priceCache.btc, gold: priceCache.gold, spx: priceCache.spx, dxy: priceCache.dxy, vix: priceCache.vix },
    risk:     riskStatus,
    setupHealth: checkSetupHealth(),
    calendar: newsCache.filter(ev => {
      if (!ev.date || !ev.impact || ev.impact.toLowerCase() !== 'high') return false;
      const evDate = new Date(ev.date).toISOString().slice(0, 10);
      return evDate === new Date().toISOString().slice(0, 10);
    }).slice(0, 8),
    todayPnl: tradeJournal.filter(t => {
      const d = (t.closeTime || t.openTime || '').slice(0, 10);
      return d === new Date().toISOString().slice(0, 10) && t.status === 'CLOSED';
    }).reduce((sum, t) => sum + (t.pnl || 0), 0),
  };
  res.json(plan);
});

// Feature flags
app.get("/api/features", (_, res) => {
  res.json({ features });
});

app.post("/api/features/:name/toggle", requireLocalOnly, (req, res) => {
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

// 6:45 AM — refresh signals + run full morning plan
cron.schedule("45 6 * * *", async () => {
  await fetchPrices();
  await refreshSignals();
  await fetchCongress();
  await fetchFlow();
  generateDailyPlan();
  console.log("[cron] 6:45 AM — plan ready");
  // Run Python daily plan generator in background
  const { execFile } = require("child_process");
  const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
  execFile(PYTHON_BIN, [require("path").join(__dirname, "..", "tv_daily_plan.py"), "--no-tv", "--silent"],
    { cwd: require("path").join(__dirname, ".."), timeout: 60000 },
    (err, out) => { if (err) console.error("[cron] daily plan error:", err.message); else console.log("[cron] daily plan done:", out.trim().slice(0, 100)); }
  );
});

// 7:00 AM — send morning plan to Telegram
cron.schedule("0 7 * * *", async () => {
  if (!TELEGRAM_TOKEN) return;
  for (const cid of knownChatIds) await sendTelegram(cid, planToTelegram(dailyPlan));
  console.log("[cron] 7:00 AM — plan sent");
});

// Every 30 min — refresh signals (4h was too slow; catches intraday setups and regime changes)
cron.schedule("*/30 * * * *", async () => {
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

// Every 30 minutes — refresh Fear & Greed index
cron.schedule("*/30 * * * *", fetchFearGreed);

// Weekdays 10 PM UTC — end-of-day review (runs eod_review.py)
cron.schedule("0 22 * * 1-5", async () => {
  console.log("[cron] EOD review starting…");
  const { execFile } = require("child_process");
  const PYTHON = process.platform === "win32" ? "python" : "python3";
  execFile(PYTHON, [require("path").join(__dirname, "..", "eod_review.py")], { cwd: require("path").join(__dirname, ".."), timeout: 120000 }, (err, out, se) => {
    if (err) console.error("[EOD] Error:", se || err.message);
    else console.log("[EOD] Done:", out.trim().slice(0, 200));
  });
});

// Sunday 9 PM — autonomous improvement proposal
cron.schedule("0 21 * * 0", async () => {
  console.log("[agent] Sunday auto-improvement run starting…");
  const closed = tradeJournal.filter(t => t.status === "CLOSED" && t.pnl !== null);
  if (closed.length < 5) { console.log("[agent] Not enough trades for improvement analysis"); return; }

  // Find worst setup
  const bySetup = {};
  for (const t of closed) {
    const s = t.setup || "UNKNOWN";
    if (!bySetup[s]) bySetup[s] = { wins: 0, losses: 0 };
    if (t.pnl > 0) bySetup[s].wins++; else bySetup[s].losses++;
  }
  let worstSetup = null, worstWR = 1;
  for (const [setup, stats] of Object.entries(bySetup)) {
    const total = stats.wins + stats.losses;
    if (total < 3) continue;
    const wr = stats.wins / total;
    if (wr < worstWR) { worstWR = wr; worstSetup = setup; }
  }

  if (!worstSetup) return;
  const proposal = {
    generatedAt: new Date().toISOString(),
    worstSetup,
    winRate: parseFloat((worstWR * 100).toFixed(1)),
    trades: bySetup[worstSetup],
    learningBoost: getLearningBoost(worstSetup),
    recommendation: `${worstSetup} has ${(worstWR * 100).toFixed(1)}% WR — review and tighten entry criteria or disable. Learning engine has already applied ${getLearningBoost(worstSetup)} confidence adjustment.`
  };

  const proposalPath = require("path").join(__dirname, "..", "tasks", "improvement_proposal.json");
  fs.writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));
  console.log(`[agent] Proposal written: ${worstSetup} at ${(worstWR * 100).toFixed(1)}% WR`);
});

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

// Signal fingerprint — skip AI analysis when signals haven't changed (cost saving)
let _lastAnalysisFingerprint = '';
function _signalFingerprint() {
  return ['btc','gold','spx'].map(k => {
    const s = signalCache[k];
    return s ? `${s.signal}:${s.setup}:${s.confidence}` : 'null';
  }).join('|');
}

async function refreshAnalysis() {
  // Skip AI calls when signals are unchanged — keeps costs low
  const fp = _signalFingerprint();
  if (fp === _lastAnalysisFingerprint && analysisCache.btc) {
    console.log('[analysis] Signals unchanged — skipping AI calls');
    return;
  }
  _lastAnalysisFingerprint = fp;

  // Rule-based analysis runs instantly for all 3 in parallel
  const [btcAuto, goldAuto, spxAuto] = await Promise.all([
    Promise.resolve(autoAnalyze(signalCache.btc)),
    Promise.resolve(autoAnalyze(signalCache.gold)),
    Promise.resolve(autoAnalyze(signalCache.spx))
  ]);

  // Start with rule-based results immediately
  analysisCache = { btc: btcAuto, gold: goldAuto, spx: spxAuto, updatedAt: new Date().toISOString(), aiEnhanced: false };

  // If Claude is available, run 3 parallel AI brains — one per asset
  if (anthropic) {
    const assets = [
      { key: "btc",  sig: signalCache.btc,  base: btcAuto  },
      { key: "gold", sig: signalCache.gold, base: goldAuto },
      { key: "spx",  sig: signalCache.spx,  base: spxAuto  }
    ];

    const results = await Promise.allSettled(assets.map(async ({ key, sig, base }) => {
      if (!sig) return { key, text: base };
      const prompt =
        `You are the dedicated AI trading analyst for ${sig.label}. ` +
        `Provide a concise professional analysis (3-4 sentences max).\n\n` +
        `Signal: ${sig.signal} | Setup: ${(sig.setup ?? "WAIT").replace(/_/g," ")} | Regime: ${sig.regime ?? "?"}\n` +
        `Trend: ${sig.trend} | RSI: ${sig.indicators?.rsi} | Confidence: ${sig.confidence ?? 0}%\n` +
        `Volume: ${sig.volume?.ratio ?? "N/A"}x avg | Vol confirmed: ${sig.volume?.confirmed ? "YES" : "NO"}\n` +
        `D:${sig.trend} 4H:${sig.h4?.trend ?? "?"} 1H:${sig.h1?.trend ?? "?"}\n` +
        (sig.signal !== "WAIT"
          ? `Entry: $${sig.entry} | Stop: $${sig.stop} | Target: $${sig.target} | R/R: 1:${sig.rr}\n`
          : "No active trade setup.\n") +
        `DXY: ${priceCache.dxy ?? "N/A"} | VIX: ${priceCache.vix ?? "N/A"}\n\n` +
        `Focus on: (1) what the setup means, (2) key risk, (3) what to watch. ` +
        `Be specific with price levels. Professional tone.`;

      const msg = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }]
      });
      return { key, text: msg.content?.[0]?.text ?? base };
    }));

    for (const r of results) {
      if (r.status === "fulfilled") {
        analysisCache[r.value.key] = r.value.text;
      }
    }
    analysisCache.updatedAt = new Date().toISOString();
    analysisCache.aiEnhanced = true;
    console.log("[analysis] 3 parallel Claude AI brains completed");
  }
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

// Full system snapshot — signals, risk, positions, self-learning, journal, health.
// This is what makes JARVIS chat aware of the whole system, not just prices.
// Deterministic open/closed check — a cheap backstop so JARVIS's answer never depends on
// the model doing correct day-of-week/timezone arithmetic. Weekday session hours only;
// does not model NYSE/forex holidays (BTC needs no such check — it never closes).
function getMarketHoursStatus() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  let goldOpen = true, goldNote = "forex hours, open";
  if (day === 6) { goldOpen = false; goldNote = "closed — forex week ends Fri ~22:00 UTC, reopens Sun ~22:00 UTC"; }
  else if (day === 0 && mins < 22 * 60) { goldOpen = false; goldNote = "closed — reopens ~22:00 UTC today (Sunday)"; }
  else if (day === 5 && mins >= 22 * 60) { goldOpen = false; goldNote = "closed — forex week just ended ~22:00 UTC"; }

  const isDST   = now.getUTCMonth() > 2 && now.getUTCMonth() < 10; // rough Mar-Nov EDT approximation
  const openMin = isDST ? 13 * 60 + 30 : 14 * 60 + 30;
  const closeMin = isDST ? 20 * 60 : 21 * 60;
  const spxOpen = day >= 1 && day <= 5 && mins >= openMin && mins < closeMin;

  return [
    `BTC: OPEN (24/7, no session breaks)`,
    `GOLD (forex): ${goldOpen ? "OPEN" : "CLOSED"} (${goldNote})`,
    `SPX (NYSE cash): ${spxOpen ? "OPEN (cash session)" : "CLOSED (outside Mon-Fri ~13:30-20:00 UTC — NYSE holidays not modeled here)"}`,
  ].join("\n");
}

function buildSystemContext() {
  const s = signalCache, p = priceCache;
  const lines = [`Current time: ${new Date().toLocaleString()}`, "", "═══ MARKET HOURS ═══", getMarketHoursStatus(), "", "═══ SIGNALS ═══"];

  for (const [key, label] of [["btc", "BTC"], ["gold", "GOLD"], ["spx", "SPX"]]) {
    const sig = s[key];
    if (!sig) { lines.push(`${label}: no data yet`); continue; }
    const price = p[key];
    const chg   = p[key + "Change"];
    lines.push(`${label}: $${price?.toLocaleString() ?? "—"} (${chg > 0 ? "+" : ""}${chg ?? "—"}% 24h) | Signal: ${sig.signal} ${sig.confidence ?? 0}% | Setup: ${sig.setup ?? "—"} | Trend: ${sig.trend ?? "—"} | Regime: ${sig.regime ?? "—"}`);
    if (sig.signal !== "WAIT" && sig.entry) lines.push(`  Entry $${sig.entry} | Stop $${sig.stop} | Target $${sig.target} | R:R ${sig.rr ?? "—"}`);
    if (sig.reasons?.length) lines.push(`  Reasons: ${sig.reasons.slice(0, 5).join(" | ")}`);
  }

  lines.push("", "═══ RISK ═══", `Daily P&L: ${riskStatus.dailyPnl ?? 0} | Consecutive losses: ${riskStatus.consecutiveLosses ?? 0} | Halted: ${riskStatus.halted ? `YES (${riskStatus.haltReason})` : "no"}`);

  lines.push("", "═══ OPEN POSITIONS (MT5) ═══");
  if (mt5Positions.length) {
    for (const pos of mt5Positions.slice(0, 10)) {
      lines.push(`${pos.type} ${pos.symbol}: entry $${pos.price}, SL $${pos.sl}, TP $${pos.tp}, P&L ${pos.profit >= 0 ? "+" : ""}$${pos.profit}, ${pos.volume} lots`);
    }
  } else lines.push("None open.");

  lines.push("", "═══ SELF-LEARNING (setup win rates) ═══");
  const setups = Object.entries(learning.setupStats || {});
  if (setups.length) {
    for (const [name, st] of setups.sort((a, b) => ((b[1].wins||0)+(b[1].losses||0)) - ((a[1].wins||0)+(a[1].losses||0))).slice(0, 8)) {
      const tot = (st.wins || 0) + (st.losses || 0);
      const wr  = tot ? Math.round((st.wins || 0) / tot * 100) : 0;
      lines.push(`${name}: ${st.wins || 0}W/${st.losses || 0}L (${wr}%) P&L ${(st.totalPnl ?? 0).toFixed ? st.totalPnl.toFixed(2) : st.totalPnl}`);
    }
  } else lines.push("No completed trades yet — nothing learned.");

  lines.push("", "═══ RECENT CLOSED TRADES ═══");
  const closed = tradeJournal.filter(t => t.status === "CLOSED" || t.pnl != null).slice(0, 5);
  if (closed.length) {
    for (const t of closed) lines.push(`${(t.symbol||"?").toUpperCase()} ${t.direction || t.dir || "?"} ${t.setup || ""} — P&L ${t.pnl}`);
  } else lines.push("No closed trades yet.");

  lines.push("", "═══ SYSTEM HEALTH ═══");
  try {
    const h = autohealer.getStatus();
    lines.push(`Healer: ${h.healthy ? "healthy" : "UNHEALTHY"} | heals performed: ${h.healCount} | last heal: ${h.lastHealAt ?? "never"}`);
    if (h.errorLog?.length) lines.push(`Recent errors: ${h.errorLog.slice(0, 3).map(e => e.message || e).join(" | ")}`);
  } catch { lines.push("Healer status unavailable."); }

  lines.push("", "═══ HERMES — validated forward paper-trading (per-asset champion geometry) ═══");
  try {
    const champs = hermes.computeChampions();
    const champEntries = Object.entries(champs);
    if (champEntries.length) {
      for (const [asset, row] of champEntries) lines.push(`${asset.toUpperCase()}: ${row.geometry} is champion — ${row.winRate}% WR, expectancy ${row.expectancy}R over ${row.trades} paper trades (costs deducted)`);
    } else lines.push("No validated champion yet for any asset — still gathering forward paper-trade samples.");
  } catch { lines.push("Hermes data unavailable."); }

  lines.push("", "═══ PERSISTENT MEMORY (facts saved across sessions — not lost on page reload) ═══");
  try {
    const recent = loadMemory().entries.slice(0, 10);
    if (recent.length) for (const e of recent) lines.push(`[${e.category}] ${e.key}: ${e.value}`);
    else lines.push("Nothing saved yet.");
  } catch { lines.push("Memory store unavailable."); }

  return lines.join("\n");
}

const JARVIS_SYSTEM_PROMPT = `You are JARVIS, Themis's trading system engineer and AI partner for SmartEntry Pro.
Personality: direct, sharp, fast, zero fluff. Talk like a senior engineer who respects his time. No "Great question!", no preambles.
You have full visibility into SmartEntry Pro's live state, which is provided below on every turn — signals, risk, open positions, self-learning stats, recent trades, system health, and persistent memory saved from past sessions. Use it. Never say you don't have access to system data — you do, it's in the context.
You have a save_memory tool — a real cross-session memory, not just this conversation. Use it whenever Themis tells you a preference, a decision, a lesson learned, or a fact worth remembering later (e.g. "I prefer 1.5x ATR stops", "we're pausing SPX trades this week"). Don't save routine chit-chat or things already in the live system state above.
You have a web_search tool for real-time information — news, events, anything current you don't already have. Use it when the question needs it instead of guessing from training data.
You have a play_video tool and you genuinely can open and play YouTube videos on Themis's screen — never say you can't play video/audio or that you're "not YouTube," that's false. Use it for ANY video request on ANY topic (trading or not — music, news, anything), including terse ones with no request verb at all ("gold video", "youtube ripple", "greek music").
You have a force_heal tool that actually runs a real health-check/repair cycle — not a status report, a real action. Use it when asked to check/fix the system, don't just describe the healer status from context.
You have list_proposals and approve_proposal tools for reviewing what an autonomous research agent has found and implemented on a branch. Use list_proposals whenever Themis asks what's pending, what the agent found, or what's waiting on him. Use approve_proposal only on a clear, specific approval — approving marks it ready to deploy next session, it does not push it live, so don't imply the change is already live.
Trading context first: weigh signal quality, risk management, and system reliability before answering.
Give concrete levels (entry/stop/target) when discussing a trade. Analysis, not financial advice.
Never loosen or suggest bypassing the 65% confidence gate or the daily-loss circuit breaker just because nothing is firing — a quiet market is a correct read, not a bug.
Keep answers tight — a few sentences unless the question genuinely needs more.`;

const MEMORY_TOOL = {
  name: "save_memory",
  description: "Save an important fact, decision, lesson, or preference to JARVIS's persistent cross-session memory (survives page reloads and future sessions). Use for things worth remembering long-term, not routine chit-chat.",
  input_schema: {
    type: "object",
    properties: {
      key:      { type: "string", description: "Short unique label, e.g. RISK_PREFERENCE or BTC_KEY_SUPPORT" },
      value:    { type: "string", description: "The fact, written so it makes sense read cold in a future session" },
      category: { type: "string", enum: ["TRADE", "SYSTEM", "MARKET", "CODE", "RISK", "LEARNING", "GENERAL"] }
    },
    required: ["key", "value"]
  }
};

const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the live web for real-time information — news, events, prices, anything outside the trading system's own data. Use whenever the question needs current information you can't get from the system state above.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "The search query" } },
    required: ["query"]
  }
};

const PLAY_VIDEO_TOOL = {
  name: "play_video",
  description: "Search YouTube and open a video player on Themis's screen. Use this any time he wants to watch/see/open a video, on any topic — trading-related or not (music, news, anything). Recognize the intent even from terse phrasing, typos, or requests with no video-request verb at all (e.g. 'gold video', 'youtube ripple').",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "What to search YouTube for" } },
    required: ["query"]
  }
};

const FORCE_HEAL_TOOL = {
  name: "force_heal",
  description: "Actually run a system health-check/repair cycle right now — not just report status, run it. Use when Themis asks you to check/fix/heal the system, or when something looks broken and he wants it addressed immediately.",
  input_schema: { type: "object", properties: {} }
};

const LIST_PROPOSALS_TOOL = {
  name: "list_proposals",
  description: "List pending/recent improvement proposals from the autonomous research agent — code changes it found and implemented on a branch, awaiting approval before anything touches the live server. Use when Themis asks what's pending, what the agent found, or what needs approval.",
  input_schema: { type: "object", properties: {} }
};

const APPROVE_PROPOSAL_TOOL = {
  name: "approve_proposal",
  description: "Mark a pending improvement proposal as approved by Themis. This does NOT deploy it — deployment to the live server is a separate, deliberate step. This just records that he has reviewed and greenlit it, so it's ready to ship next session. Use only when he clearly approves a specific proposal (by id or by unambiguous description) — if it's not clear which one, ask, don't guess.",
  input_schema: {
    type: "object",
    properties: { id: { type: "string", description: "The proposal id, e.g. prop_abc123" } },
    required: ["id"]
  }
};

async function braveWebSearch(query) {
  // Env vars set via the Windows GUI often pick up invisible copy-paste artifacts
  // (non-breaking spaces etc.) that silently break header auth — strip anything non-printable-ASCII.
  const key = (process.env.BRAVE_API_KEY || "").replace(/[^\x21-\x7e]/g, "");
  if (!key) return "Web search unavailable — no BRAVE_API_KEY configured.";
  try {
    const r = await axios.get("https://api.search.brave.com/res/v1/web/search", {
      params: { q: query, count: 5 },
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      timeout: 10000
    });
    const results = r.data?.web?.results || [];
    if (!results.length) return "No web results found.";
    return results.slice(0, 5).map((res, i) => `${i + 1}. ${res.title}\n   ${res.url}\n   ${res.description || ""}`).join("\n\n");
  } catch (e) {
    console.error("[web_search] error:", e.message);
    return "Web search failed: " + e.message;
  }
}

async function askClaude(question, history = []) {
  const context = buildSystemContext();

  if (anthropic) {
    const msgs = history
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content }));
    msgs.push({ role: "user", content: `[Live system state]\n${context}\n\n[Question]\n${question}` });

    // Opus 5, not 4.8: this is the JARVIS brain, the one path that reasons over live
    // system state with tools in hand. Everything narrower (commentary, summaries,
    // per-asset analysis) stays on sonnet-5 where the cost/latency matters more than
    // the last increment of reasoning.
    const callOpts = { model: "claude-opus-5", max_tokens: 1024, system: JARVIS_SYSTEM_PROMPT, tools: [MEMORY_TOOL, WEB_SEARCH_TOOL, PLAY_VIDEO_TOOL, FORCE_HEAL_TOOL, LIST_PROPOSALS_TOOL, APPROVE_PROPOSAL_TOOL] };
    let response = await anthropic.messages.create({ ...callOpts, messages: msgs });

    // Tool-use loop: let JARVIS actually save memories, search the web, and open videos mid-conversation.
    let video = null;
    let guard = 0;
    while (response.stop_reason === "tool_use" && guard < 3) {
      guard++;
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let resultText = "Unknown tool.";
        if (block.name === "save_memory") {
          const { key, value, category } = block.input || {};
          resultText = "Save failed — missing key or value.";
          if (key && value) {
            try { saveMemoryEntry(key, value, category, "jarvis-chat"); resultText = `Saved: ${key}`; }
            catch (e) { resultText = "Save failed: " + e.message; }
          }
        } else if (block.name === "web_search") {
          resultText = await braveWebSearch(block.input?.query || "");
        } else if (block.name === "play_video") {
          const q = block.input?.query || "";
          try {
            const results = await searchYouTube(q);
            if (results.length) {
              video = { query: q, results };
              resultText = `Now playing on screen: "${results[0].title}" (${results[0].channel}). Acknowledge briefly — don't list the results, he can already see them.`;
            } else resultText = "No YouTube results found for that.";
          } catch (e) { resultText = "Video search failed: " + e.message; }
        } else if (block.name === "force_heal") {
          try {
            const result = await autohealer.forceHeal();
            resultText = `Heal cycle ran. Healthy: ${result.healthy}. Total heals so far: ${result.healCount}. Last heal: ${result.lastHealAt ?? "just now"}.`;
          } catch (e) { resultText = "Force-heal failed: " + e.message; }
        } else if (block.name === "list_proposals") {
          const { proposals } = loadProposals();
          if (!proposals.length) resultText = "No proposals on record.";
          else resultText = proposals.slice(0, 10).map(p =>
            `[${p.status}] ${p.id} — ${p.summary}${p.prUrl ? ` (${p.prUrl})` : ""} (${p.createdAt})`
          ).join("\n");
        } else if (block.name === "approve_proposal") {
          const { id } = block.input || {};
          const data = loadProposals();
          const prop = data.proposals.find(p => p.id === id);
          if (!prop) resultText = `No proposal found with id ${id}.`;
          else {
            prop.status = "approved";
            prop.approvedAt = new Date().toISOString();
            saveProposals(data);
            resultText = `Approved: ${prop.summary}. Marked ready to deploy next session — this did not deploy it live.`;
          }
        } else continue;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
      }
      msgs.push({ role: "assistant", content: response.content });
      msgs.push({ role: "user", content: toolResults });
      response = await anthropic.messages.create({ ...callOpts, messages: msgs });
    }

    const text = response.content?.find(b => b.type === "text")?.text;
    console.log("[chat] Claude reply length:", text?.length ?? 0, video ? "| video: " + video.query : "");
    return { text, video };
  }

  // Fallback — rule-based response without API key
  const q = question.toLowerCase();
  if (q.includes("btc") || q.includes("bitcoin")) return { text: autoAnalyze(signalCache.btc) ?? "BTC signal not available.", video: null };
  if (q.includes("gold") || q.includes("xau"))    return { text: autoAnalyze(signalCache.gold) ?? "Gold signal not available.", video: null };
  if (q.includes("spy") || q.includes("s&p"))     return { text: autoAnalyze(signalCache.spx)  ?? "SPY signal not available.", video: null };
  return { text: `Here is the current system snapshot:\n\n${context}\n\nAsk me about a specific asset (BTC, Gold, SPY), risk, positions, or what I've learned.`, video: null };
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

async function fetchFearGreed() {
  try {
    const res = await axios.get("https://api.alternative.me/fng/?limit=1", { timeout: 8000 });
    const data = res.data?.data?.[0];
    if (data) {
      sentimentCache.fearGreed = parseInt(data.value, 10);
      sentimentCache.classification = data.value_classification;
      sentimentCache.updated = new Date().toISOString();
      const fg = sentimentCache.fearGreed;
      sentimentCache.btcSentiment = fg >= 60 ? "BULLISH" : fg <= 40 ? "BEARISH" : "NEUTRAL";
      console.log(`[sentiment] Fear & Greed: ${fg} (${sentimentCache.classification})`);
    }
  } catch (e) {
    console.error("[sentiment] Fear & Greed fetch failed:", e.message);
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
      model:      "claude-sonnet-5",
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
      model:      "claude-sonnet-5",
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
      model:      "claude-sonnet-5",
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
      bars.push({ ts: tss[i], close: q.close[i], high: q.high[i], low: q.low[i], volume: q.volume?.[i] ?? 0 });
  }

  const trades = [];
  let lastKey  = null;
  const MIN    = 210;  // warm-up for EMA200

  for (let i = MIN; i < bars.length; i++) {
    const w = bars.slice(0, i + 1);
    const sig = generateSignal(label, symbol,
      w.map(b => b.close), w.map(b => b.high), w.map(b => b.low), w.map(b => b.volume ?? 0));
    if (!sig || sig.signal === "WAIT" || !sig.stop || !sig.target) { lastKey = null; continue; }

    // Keep every setup that produced a tradeable signal. Filtering to what live
    // would actually take happens after the loop, so both figures come from one
    // pass over identical data and are directly comparable.
    //
    // MODERATE used to be scored as exactly 65 and let through, which is why the
    // headline backtest described a looser strategy than the one connected to the
    // broker: auto mode discards everything that is not STRONG.
    if (sig.strength !== "STRONG" && sig.strength !== "MODERATE") { lastKey = null; continue; }

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
      signal, setup: sig.setup, strength: sig.strength,
      entry:    parseFloat(entry.toFixed(2)),
      sl:       parseFloat(sl.toFixed(2)),
      tp:       parseFloat(tp.toFixed(2)),
      rr, outcome, barsHeld
    });
  }

  return {
    symbol, label, years,
    // What the live system would actually have traded. AUTO mode refuses anything
    // that is not STRONG, so this is the headline figure — the previous one
    // included MODERATE setups the broker connection would never have taken.
    ...summariseBacktest(trades.filter(t => t.strength === "STRONG")),
    // Kept alongside so the cost of that filter is visible rather than implied.
    allSetups: summariseBacktest(trades),
    filter: {
      applied: "STRONG only — matches AUTO_MODE in mt5_bridge.py",
      caveat:  "Real live confidence also requires Daily/4H/1H agreement, which daily bars "
             + "cannot reproduce. Live will therefore trade the same or fewer times than shown here, never more.",
    },
  };
}

// Shared so the live-equivalent and all-setups figures are computed identically and
// any difference between them is the filter, not the arithmetic.
function summariseBacktest(trades) {
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

  // Averaged over CLOSED trades only. Including EXPIRED ones — which never hit a
  // stop or target and move equity not at all — dragged the average R down and
  // made expectancy read worse than the trades that actually resolved.
  const closedTrades = trades.filter(t => t.outcome === "WIN" || t.outcome === "LOSS");
  const avgRR = closedTrades.length
    ? closedTrades.reduce((s, t) => s + t.rr, 0) / closedTrades.length
    : 0;

  return {
    totalTrades:  trades.length,
    resolved:     closed,
    expired:      trades.length - closed,
    wins, losses, winRate,
    avgRR:        parseFloat(avgRR.toFixed(1)),
    profitFactor,
    startEquity:  10000,
    finalEquity:  parseFloat(equity.toFixed(0)),
    returnPct:    parseFloat(((equity - 10000) / 100).toFixed(1)),
    maxDrawdown:  parseFloat(maxDD.toFixed(1)),
    expectancy:   parseFloat(((winRate / 100 * avgRR) - (1 - winRate / 100)).toFixed(2)),
    curve:        curve.slice(-120),
    recentTrades: trades.slice(-15),
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
    { key: "spx",  label: "S&P500",     symbol: "^GSPC"   }
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
        model: "claude-sonnet-5", max_tokens: 500,
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

// Claude AI trade approval — called by MT5 bridge before executing any order
app.post("/api/claude-approve-trade", async (req, res) => {
  const { signal, symbol, entry, stop, target } = req.body ?? {};
  if (!anthropic || !signal) return res.json({ approved: true, reason: "No AI available — proceeding", risk: "UNKNOWN" });

  const rr = (entry && stop && target)
    ? (Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(1)
    : "N/A";
  const newsCheck = isNewsBlackout();
  const macro = `DXY ${priceCache.dxy ?? "N/A"} | VIX ${priceCache.vix ?? "N/A"}`;

  const prompt =
    `You are a professional algorithmic trading risk manager. Evaluate this trade signal.\n\n` +
    `Trade: ${signal.signal} ${symbol}\n` +
    `Setup: ${(signal.setup ?? "").replace(/_/g," ")} | Trend: ${signal.trend ?? "?"}\n` +
    `Entry: $${entry} | Stop: $${stop} | Target: $${target} | R/R: 1:${rr}\n` +
    `RSI: ${signal.indicators?.rsi ?? "?"} | MACD: ${signal.indicators?.macd?.bullish ? "Bullish" : "Bearish"}\n` +
    `Volume: ${signal.volume?.ratio ?? "N/A"}x avg | Vol confirmed: ${signal.volume?.confirmed ? "YES" : "NO"}\n` +
    `Confidence score: ${signal.confidence ?? 0}%\n` +
    `Macro: ${macro}\n` +
    `News blackout: ${newsCheck.blackout ? "YES — " + newsCheck.reason : "CLEAR"}\n\n` +
    `Current market:\n${buildMarketContext()}\n\n` +
    `APPROVE the trade if ALL of: confidence >= 60%, R/R >= 1.5, no news blackout, macro not strongly against.\n` +
    `REJECT if: confidence < 60%, R/R < 1.5, news blackout active, strong macro headwind (strong DXY against Gold/BTC long), or VIX > 30 on a BUY.\n\n` +
    `Reply with ONLY valid JSON, no markdown:\n` +
    `{"approved": true, "reason": "one sentence max", "risk": "LOW"}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 1200,
      thinking: { type: "enabled", budget_tokens: 800 },
      messages: [{ role: "user", content: prompt }]
    });
    const text = (msg.content ?? []).find(b => b.type === "text")?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    const approved = parsed?.approved ?? true;
    const reason   = parsed?.reason   ?? "No reason given";
    const risk     = parsed?.risk     ?? "MEDIUM";
    console.log(`[AI-filter] ${symbol} ${signal.signal}: ${approved ? "APPROVED" : "REJECTED"} — ${reason}`);
    res.json({ approved, reason, risk });
  } catch (e) {
    console.error("[AI-filter] Error:", e.message);
    res.json({ approved: true, reason: "AI error — proceeding", risk: "MEDIUM" });
  }
});

// Market regime endpoint
app.get("/api/regime/:key", (_, res) => {
  const key = _.params?.key ?? "btc";
  const sig = signalCache[key];
  if (!sig) return res.json({ regime: "UNKNOWN" });
  const { indicators, trend } = sig;
  const rsi = indicators?.rsi ?? 50;
  const bb  = indicators?.bb;
  // Detect regime
  let regime = "RANGING";
  if (trend === "STRONG UPTREND" || trend === "STRONG DOWNTREND") regime = "TRENDING";
  if (bb && bb.bandwidth < 8) regime = "SQUEEZE";   // Bollinger squeeze = breakout incoming
  if (bb && bb.bandwidth > 25) regime = "VOLATILE";
  res.json({ regime, trend, rsi, bandwidth: bb?.bandwidth });
});

// Run 3 parallel Claude AI analyses on demand
app.post("/api/ai-brain", async (req, res) => {
  if (!anthropic) return res.json({ error: "No Claude API key" });
  console.log("[ai-brain] Running 3 parallel Claude Opus analyses…");
  const start = Date.now();

  const assets = [
    { key: "btc",  sig: signalCache.btc  },
    { key: "gold", sig: signalCache.gold },
    { key: "spx",  sig: signalCache.spx  }
  ];

  const results = await Promise.allSettled(assets.map(async ({ key, sig }) => {
    if (!sig) return { key, analysis: null };
    const prompt =
      `You are the dedicated AI trading brain for ${sig.label} (${key.toUpperCase()}). ` +
      `This is a real-time institutional-grade trading analysis.\n\n` +
      `=== CURRENT STATE ===\n` +
      `Signal: ${sig.signal} | Strength: ${sig.strength} | Confidence: ${sig.confidence}%\n` +
      `Regime: ${sig.regime} | Setup: ${(sig.setup ?? "WAIT").replace(/_/g," ")}\n` +
      `Price: $${sig.price} | Trend: ${sig.trend}\n` +
      `RSI(14): ${sig.indicators?.rsi} | MACD: ${sig.indicators?.macd?.bullish ? "BULLISH" : "BEARISH"}\n` +
      `BB Width: ${sig.indicators?.bb?.bandwidth}% | EMA200: $${sig.indicators?.ema200 ?? "N/A"}\n` +
      `Volume: ${sig.volume?.ratio ?? "N/A"}x 20d avg | Confirmed: ${sig.volume?.confirmed ? "YES" : "NO"}\n` +
      `Timeframes: D:${sig.trend} | 4H:${sig.h4?.trend ?? "?"} (RSI ${sig.h4?.rsi ?? "?"}) | 1H:${sig.h1?.trend ?? "?"}\n` +
      (sig.pivots ? `Pivots: S1 $${sig.pivots.s1} | PP $${sig.pivots.pp} | R1 $${sig.pivots.r1}\n` : "") +
      (sig.signal !== "WAIT" ? `Trade: Entry $${sig.entry} | Stop $${sig.stop} | Target $${sig.target} | R/R 1:${sig.rr}\n` : "") +
      `\n=== MACRO ===\n` +
      `DXY: ${priceCache.dxy ?? "N/A"} (${priceCache.dxyChange > 0 ? "+" : ""}${priceCache.dxyChange ?? 0}%)\n` +
      `VIX: ${priceCache.vix ?? "N/A"}\n` +
      `\nProvide a 5-sentence professional trading brief: ` +
      `(1) current market structure, (2) what the signal/lack of signal means, ` +
      `(3) key levels to watch, (4) execution plan if signal fires, (5) main risk. ` +
      `Be specific with prices. Institutional quality.`;

    const msg = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 1000,
      thinking: { type: "enabled", budget_tokens: 500 },
      messages: [{ role: "user", content: prompt }]
    });
    const analysis = (msg.content ?? []).find(b => b.type === "text")?.text ?? null;
    return { key, analysis };
  }));

  const out = { elapsed: Date.now() - start };
  for (const r of results) {
    if (r.status === "fulfilled") out[r.value.key] = r.value.analysis;
  }
  console.log(`[ai-brain] 3 parallel analyses done in ${out.elapsed}ms`);
  res.json(out);
});

// ── Serve pages ──────────────────────────────────────────────
// HTML must revalidate on every load. Without this a browser can keep serving a
// cached dashboard from memory, so a deployed change appears simply not to exist —
// which has cost real time today, hunting for updates that were already live.
// ETags still make the revalidation cheap (304, no re-download).
app.use("/dashboard", express.static(path.join(__dirname, "..", "dashboard"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  },
}));
app.get("/dashboard", (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "index.html")));
app.get("/daily-plan", (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "daily-plan.html")));
app.get("/command",    (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "command.html")));
app.get("/jarvis",     (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "jarvis.html")));
app.get("/system",     (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "system.html")));
app.get("/plan",       (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "plan.html")));
app.use("/screenshots", express.static(path.join(__dirname, "..", "dashboard", "screenshots")));
app.use(express.static(path.join(__dirname, "..", "commercial")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "..", "commercial", "index.html")));

// ── /api/healer ───────────────────────────────────────────────
app.get("/api/healer", (_, res) => {
  res.json(autohealer.getStatus());
});

app.post("/api/healer/heal", async (_, res) => {
  try {
    const result = await autohealer.forceHeal();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── /api/system-plan ──────────────────────────────────────────
// Feeds dashboard/plan.html. Everything here is DERIVED from live state rather
// than written down, because a hand-maintained status page is wrong within a week
// and a status page that is quietly wrong is worse than none — that is exactly how
// the healer came to report "1/1 account(s) reporting" while half the bridges were
// dead. If a fact here is stale, the system it describes has changed, not the page.
const SCHEDULED_TASK_PREFIX = "SmartEntry";
const TASK_QUERY_TIMEOUT_MS = 8000;

// Scheduled Tasks are a Windows-only concept; on anything else report "unavailable"
// rather than pretending the components are missing.
function readScheduledTasks() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve({ available: false, tasks: [] });

    const child = require("child_process").spawn("schtasks", ["/query", "/fo", "csv", "/nh"], { windowsHide: true });
    let stdout = "";
    let settled = false;

    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ available: false, tasks: [] }); }, TASK_QUERY_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => { clearTimeout(timer); finish({ available: false, tasks: [] }); });
    child.on("close", () => {
      clearTimeout(timer);
      const tasks = stdout.split(/\r?\n/).reduce((acc, line) => {
        // csv: "TaskName","Next Run Time","Status"
        const cells = line.split('","').map(c => c.replace(/^"|"$/g, "").trim());
        if (cells.length < 3) return acc;
        const name = cells[0].replace(/^\\+/, "");
        if (!name.startsWith(SCHEDULED_TASK_PREFIX)) return acc;
        acc.push({ name, nextRun: cells[1], status: cells[2] });
        return acc;
      }, []);
      finish({ available: true, tasks });
    });
  });
}

function readLatestBackup() {
  const backupDir = "C:\\ai-trading-dashboard-backups";
  try {
    if (!fs.existsSync(backupDir)) return null;
    const newest = fs.readdirSync(backupDir)
      .filter(name => name.toLowerCase().endsWith(".zip"))
      .map(name => {
        const stat = fs.statSync(path.join(backupDir, name));
        return { name, sizeKB: Math.round(stat.size / 1024), modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))[0];
    return newest || null;
  } catch (_) {
    return null;
  }
}

// Things only a human can clear. Derived from configuration, so an item disappears
// when it is genuinely resolved rather than when someone remembers to delete it.
function deriveActionItems(expectedAccounts, reportingAccounts) {
  const items = [];

  const missingBridges = expectedAccounts.filter(tag => !reportingAccounts.includes(tag));
  if (missingBridges.length > 0) {
    items.push({
      severity: "high",
      title: `Bridge ${missingBridges.join(", ")} expected but not reporting`,
      detail: "A bridge this deployment declares as required is silent. Check its terminal login and the bridge log.",
    });
  }

  if (!expectedAccounts.includes("B")) {
    items.push({
      severity: "medium",
      title: "Bridge B disabled — needs a second demo account",
      detail: "This machine holds one broker account. Two bridges on one account would place every trade twice at double risk, so B stays off until a second account exists. Then set MT5_EXPECTED_LOGIN in start_bridge_B_vps.bat and MT5_EXPECTED_ACCOUNTS=A,B.",
    });
  }

  items.push({
    severity: "low",
    title: "No log rotation",
    detail: "tasks/logs grows without bound. Not urgent at current disk headroom, but nothing trims it.",
  });

  items.push({
    severity: "low",
    title: "Voice needs a trusted origin",
    detail: "Chrome allows the microphone only on HTTPS or localhost. Use the SSH tunnel at localhost:3002, or finish the cloudflared tunnel for a real HTTPS URL that also works on a phone.",
  });

  return items;
}

app.get("/api/system-plan", async (_, res) => {
  try {
    const healer   = autohealer.getStatus();
    const taskInfo = await readScheduledTasks();

    const reportingAccounts = Object.entries(mt5LastSeenByAccount)
      .filter(([, seenAt]) => Date.now() - new Date(seenAt).getTime() < MT5_HEARTBEAT_STALE_MS)
      .map(([tag]) => tag);

    const expectedAccounts = (process.env.MT5_EXPECTED_ACCOUNTS ?? "A,B")
      .split(",").map(tag => tag.trim()).filter(Boolean);

    res.json({
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      serverStartedAt: SERVER_START,
      healthy: healer.healthy,
      checks: healer.checks,
      bridges: {
        expected:  expectedAccounts,
        reporting: reportingAccounts,
      },
      scheduledTasks: taskInfo,
      latestBackup: readLatestBackup(),
      actionItems: deriveActionItems(expectedAccounts, reportingAccounts),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/size — Kelly-based position sizing ───────────────────
app.post("/api/size", (req, res) => {
  try {
    const { accountBalance, signal, openPositions } = req.body || {};
    if (!accountBalance || !signal) {
      return res.status(400).json({ error: "accountBalance and signal required" });
    }
    const validation = sizing.validateTrade(signal, accountBalance, openPositions || []);
    res.json(validation);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Improvement proposals — findings from the autonomous research agent ─────
// The agent runs in an isolated cloud sandbox with no SSH/local access, so it can't
// reach this server directly except over this one relay endpoint, gated by a shared
// secret (not IP-restricted, since the cloud agent has no fixed/local address).
const PROPOSALS_PATH   = path.join(__dirname, "..", "tasks", "proposals.json");
const AGENT_RELAY_SECRET = (process.env.AGENT_RELAY_SECRET || "").trim();

function loadProposals() {
  try {
    if (fs.existsSync(PROPOSALS_PATH)) return JSON.parse(fs.readFileSync(PROPOSALS_PATH, "utf8"));
  } catch {}
  return { proposals: [] };
}
function saveProposals(data) {
  fs.mkdirSync(path.dirname(PROPOSALS_PATH), { recursive: true });
  fs.writeFileSync(PROPOSALS_PATH, JSON.stringify(data, null, 2));
}

// Cloud research agent calls this to report findings and/or register a proposed change.
app.post("/api/agent/notify", (req, res) => {
  const { secret, message, proposal } = req.body || {};
  if (!AGENT_RELAY_SECRET || secret !== AGENT_RELAY_SECRET) {
    return res.status(403).json({ error: "invalid or missing secret" });
  }

  let id = null;
  if (proposal && typeof proposal === "object") {
    const data = loadProposals();
    id = "prop_" + Date.now().toString(36);
    data.proposals.unshift({
      id,
      summary:      proposal.summary || "(no summary provided)",
      branch:       proposal.branch || null,
      prUrl:        proposal.prUrl || null,
      filesChanged: proposal.filesChanged || [],
      createdAt:    new Date().toISOString(),
      status:       "pending"
    });
    saveProposals(data);
  }

  if (message && TELEGRAM_TOKEN) {
    const chatId = TELEGRAM_CHAT_ID || [...knownChatIds][0];
    if (chatId) sendTelegram(chatId, message).catch(() => {});
  }

  res.json({ ok: true, id });
});

// ── /api/memory — persistent JARVIS memory (read/write) ──────
// Same store memory.py (the CLI tool used by Claude Code sessions) reads and writes —
// this is what makes the web chat's memory genuinely cross-session, not just this tab.
const MEMORY_PATH = path.join(__dirname, "..", "tasks", "jarvis_memory.json");

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_PATH)) return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
  } catch {}
  return { version: 1, entries: [] };
}

function saveMemoryEntry(key, value, category, source = "manual") {
  const data = loadMemory();
  const now = new Date().toISOString();
  const idx = data.entries.findIndex(e => e.key.toLowerCase() === key.toLowerCase());
  const entry = { key, value, category: (category || "GENERAL").toUpperCase(), source, updated_at: now };
  if (idx >= 0) data.entries[idx] = { ...data.entries[idx], ...entry };
  else { entry.created_at = now; data.entries.unshift(entry); }
  data.last_updated = now;
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2));
  return data.entries[idx >= 0 ? idx : 0];
}

app.get("/api/memory", (_, res) => {
  try {
    res.json(loadMemory());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/memory", (req, res) => {
  try {
    const { key, value, category } = req.body || {};
    if (!key || !value) return res.status(400).json({ error: "key and value required" });
    const entry = saveMemoryEntry(key, value, category, "manual");
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/engineer — AI Parallel: architect a task, then run real ──────
// parallel `claude -p` sub-agents (same mechanism as the /engineer skill),
// triggerable from the System dashboard instead of a manual PowerShell block.
const { spawn: spawnEngineerAgent } = require("child_process");
const REPO_ROOT             = path.join(__dirname, "..");
const ENGINEER_PLAN_PATH    = path.join(REPO_ROOT, "tasks", "engineer-plan.md");
const ENGINEER_MAX_WORKERS  = 6;
const ENGINEER_AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min safety cap per agent
const engineerRuns = {}; // runId -> { task, status, workers[], createdAt, startedAt, finishedAt }

function newEngineerRunId() {
  return "run_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

// Shared guard for admin-level actions with no auth layer of their own (AI Parallel code
// execution, server shutdown, settings/secret writes, learning-data reset, feature toggles).
// On an internet-reachable server these were previously callable by anyone who found the
// URL — restrict them to the server's own loopback address, same pattern as /api/mt5/login.
function requireLocalOnly(req, res, next) {
  const remote = req.socket.remoteAddress || "";
  const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLocal) {
    return res.status(403).json({ error: "This admin action only accepts requests from the server's own machine." });
  }
  next();
}

// Step 1 — architect: split the task into independent, non-overlapping workstreams.
app.post("/api/engineer/architect", requireLocalOnly, async (req, res) => {
  const task = (req.body?.task || "").trim();
  if (!task) return res.status(400).json({ error: "task required" });
  if (!anthropic) return res.status(503).json({ error: "Claude API not configured (ANTHROPIC_API_KEY missing)" });

  try {
    const prompt =
      `You are a software architect splitting a coding task into independent parallel workstreams for the ` +
      `SmartEntry Pro trading dashboard repo (Node/Express server in server/, static dashboard pages in ` +
      `dashboard/, Python trading scripts in the repo root).\n\n` +
      `TASK: ${task}\n\n` +
      `Break this into 2-${ENGINEER_MAX_WORKERS} independent workstreams. Each workstream must own a distinct, ` +
      `non-overlapping set of files so they can be built simultaneously with zero merge conflicts. If the task ` +
      `is too small to parallelize, return exactly 1 workstream.\n\n` +
      `Respond with ONLY strict JSON, no markdown fences, no commentary:\n` +
      `{"workstreams":[{"name":"short-id","files":"which files this agent owns","task":"exact self-contained ` +
      `instructions for this agent, written as if briefing a colleague with no other context"}]}`;

    const msg = await anthropic.messages.create({
      // Opus 5: this call decides how work is split across parallel agents, and a
      // bad split costs every downstream agent's time plus a merge conflict.
      model: "claude-opus-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    });
    const text = (msg.content ?? []).find(b => b.type === "text")?.text ?? "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    const workstreams = (parsed.workstreams || []).slice(0, ENGINEER_MAX_WORKERS);
    if (!workstreams.length) return res.status(500).json({ error: "Architect returned no workstreams" });

    const runId = newEngineerRunId();
    engineerRuns[runId] = {
      task, status: "planned",
      workers: workstreams.map(w => ({
        name: w.name, files: w.files, task: w.task,
        status: "queued", output: "", exitCode: null, pid: null
      })),
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null
    };

    fs.mkdirSync(path.dirname(ENGINEER_PLAN_PATH), { recursive: true });
    fs.writeFileSync(ENGINEER_PLAN_PATH,
      `# Engineer Plan — ${new Date().toISOString()}\n\nTask: ${task}\n\n` +
      workstreams.map((w, i) => `## ${i + 1}. ${w.name}\nFiles: ${w.files}\n\n${w.task}\n`).join("\n")
    );

    res.json({ runId, plan: workstreams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Step 2 — launch: spawn one real `claude -p` process per workstream.
// The prompt is sent over stdin, never as a CLI argument or shell string —
// nothing user-controlled is ever interpolated into a shell command.
app.post("/api/engineer/launch", requireLocalOnly, (req, res) => {
  const runId = req.body?.runId;
  const run = engineerRuns[runId];
  if (!run) return res.status(404).json({ error: "Unknown runId — call /api/engineer/architect first" });
  if (run.status === "running") return res.status(409).json({ error: "This run is already in progress" });
  if (Object.values(engineerRuns).some(r => r.status === "running")) {
    return res.status(409).json({ error: "Another engineer run is already in progress — wait for it to finish" });
  }

  run.status = "running";
  run.startedAt = new Date().toISOString();

  run.workers.forEach(worker => {
    worker.status = "running";
    const briefing =
      `SmartEntry Pro engineer. Your task: ${worker.task}\n\n` +
      `Only touch these files: ${worker.files}\n` +
      `Commit after each file. Write working code only. Do not touch files outside your scope.`;

    const child = spawnEngineerAgent(
      "claude",
      ["-p", "--dangerously-skip-permissions"],
      { cwd: REPO_ROOT, windowsHide: true, shell: true }
    );
    worker.pid = child.pid;

    const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, ENGINEER_AGENT_TIMEOUT_MS);

    child.stdout.on("data", d => { worker.output = (worker.output + d.toString()).slice(-6000); });
    child.stderr.on("data", d => { worker.output = (worker.output + d.toString()).slice(-6000); });
    child.on("error", e => { worker.output += `\n[spawn error] ${e.message}`; });
    child.on("close", code => {
      clearTimeout(killTimer);
      worker.status = code === 0 ? "done" : "error";
      worker.exitCode = code;
      if (run.workers.every(w => w.status === "done" || w.status === "error")) {
        run.status = run.workers.some(w => w.status === "error") ? "completed_with_errors" : "completed";
        run.finishedAt = new Date().toISOString();
      }
    });

    child.stdin.write(briefing, "utf8");
    child.stdin.end();
  });

  res.json({ ok: true, runId });
});

app.get("/api/engineer/status/:runId", requireLocalOnly, (req, res) => {
  const run = engineerRuns[req.params.runId];
  if (!run) return res.status(404).json({ error: "Unknown runId" });
  res.json({
    task: run.task, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
    workers: run.workers.map(w => ({
      name: w.name, files: w.files, status: w.status, exitCode: w.exitCode,
      outputTail: w.output.slice(-1500)
    }))
  });
});

app.get("/api/engineer/runs", requireLocalOnly, (_, res) => {
  const runs = Object.entries(engineerRuns)
    .map(([runId, r]) => ({
      runId, task: r.task, status: r.status, createdAt: r.createdAt,
      workerCount: r.workers.length
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);
  res.json({ runs });
});

// ── Boot ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ SmartEntry Pro v12 on port ${PORT}`);

  // Init SQLite (graceful if better-sqlite3 not installed)
  const dbPath = process.env.DB_PATH || path.join(__dirname, "smartentry.db");
  db.init(dbPath);

  await fetchPrices();
  await refreshSignals();
  await fetchCongress();
  await fetchFlow();
  await fetchEconomicCalendar();
  await fetchFearGreed();
  generateDailyPlan();
  ensureTelegramPolling();
  if (ANTHROPIC_API_KEY) console.log("[ai] Claude AI enabled ✅");
  else console.log("[ai] No ANTHROPIC_API_KEY — using rule-based analysis");

  // Start auto-healer with server context
  // eslint-disable-next-line no-undef
  const _learning = (typeof learning !== "undefined") ? learning : {};
  autohealer.start({
    signalCache,
    priceCache,
    learning: _learning,
    tradeJournal: (typeof tradeJournal !== "undefined") ? tradeJournal : [],
    mt5LastSeenByAccount,
    TELEGRAM_TOKEN,
    knownChatIds,
    refreshSignals,
    fetchPrices,
  });
  console.log('[BOOT] Auto-healer + SQLite DB active');
});
