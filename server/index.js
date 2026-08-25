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
const os         = require("os");
const { YouTube } = require("youtube-sr");

// keys.env -> process.env, and it MUST happen here, above the local requires.
//
// keys.env has always been the documented place to configure this system and
// readKeysEnv() has always parsed it, but nothing ever copied the result into
// process.env — so every `process.env.X` lookup silently used its default no
// matter what the file said. Loading it lower down was not enough either:
// autohealer.js:33 captures EXPECTED_MT5_ACCOUNTS at module-load time, so a
// loader placed after `require("./autohealer")` runs too late to be seen. That
// is why keys.env said MT5_EXPECTED_ACCOUNTS=A while the healer went on
// reporting "1/2 expected account(s) — B has never connected" on a machine
// that deliberately owns one bridge.
//
// Any module that reads config at load time has the same requirement, so this
// stays first. A real environment variable still wins: only unset keys are
// filled, so a launcher or scheduled task can always override the file.
(function loadKeysEnvIntoProcessEnv() {
  const keysEnvPath = path.join(__dirname, "..", "keys.env");
  try {
    if (!fs.existsSync(keysEnvPath)) return;
    for (const line of fs.readFileSync(keysEnvPath, "utf8").split(/\r?\n/)) {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key && value !== "" && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (e) {
    console.error("[boot] keys.env could not be loaded, running on defaults:", e.message);
  }
})();

// ── New modules ───────────────────────────────────────────────
const autohealer = require("./autohealer");
const db         = require("./db");
const sizing     = require("./sizing");
const hermes     = require("./hermes");
// Fair Value Gap geometry. Pure functions over the bar arrays the engine already
// holds — no I/O, no state, and nothing it exports can reach the trading path.
const fvg        = require("./fvg");
// Per-gate verdicts over the scored rejection ledger. Reads one file, aggregates,
// returns. Cannot reach the trading path — see the header of that module.
const rejectionEvidence = require("./rejection_evidence");
// Deliberately required lazily inside the handler instead of here: it pulls in
// tasks/doctor.cjs and tasks/sizing_trigger.cjs, and sizing_trigger READS THIS FILE
// off disk at call time to extract realizedRFromPrices. Requiring it at module load
// would run that extraction against a half-evaluated index.js during boot.
// AI Brain reading surfaces: the skill/agent/tool catalogue and the curated
// register of what has actually been measured. Both read-only and fail-soft.
const aiRegistry      = require("./ai_registry");
const evidenceRegister = require("./evidence_register");
// Evidence-accumulation curve. The Performance tab tracks P&L growth, which is
// blank on one closed fill; this tracks the thing that is actually moving.
const learningGrowth  = require("./learning_growth");
// The AI employee's timesheet: did the scheduled agents run, did they succeed,
// and has anything they proposed ever been read. Read-only over their own logs.
const aiWorkLedger    = require("./ai_work_ledger");
// The fleet doctor. Same module the CLI runs, so `node tasks/doctor.cjs` and the
// dashboard can never drift into disagreeing about the state of the two boxes.
const fleetDoctor     = require("../tasks/doctor.cjs");
// Cohort reachability table. Shared with tasks/cohort_reachability.cjs so the audit
// script and the server can never describe two different systems.
const cohortTable = require("./cohort_table");
// Live-vs-replay tracker: does the running system trade like the walk-forward that
// justified its config? Read-only, and floored so it stays silent until the sample
// can carry a verdict. See the module header for why this gap matters.
//
// Guarded for the same reason require("./rejection_log") below is guarded, and it is
// not hypothetical: an untracked module once killed the VPS server on boot. The file
// IS tracked, so a fresh checkout is safe — but the documented VPS deploy path is not
// a checkout. index.js is PATCHED there by hand because the VPS git history has
// diverged, so patching this line across without also copying server/live_vs_replay.js
// would exit the process at startup on the box that trades continuously, and
// ensure_running.ps1 would restart it into the same crash loop.
let liveVsReplay;
try {
  liveVsReplay = require("./live_vs_replay");
} catch (e) {
  console.error("[live-vs-replay] module not loaded — endpoint will report unavailable:", e.message);
  liveVsReplay = {
    buildLiveVsReplay: () => ({
      available: false,
      feedsTheGate: false,
      reason: "server/live_vs_replay.js is not deployed on this box",
    }),
  };
}
// Universal rejection ledger — see tasks/REJECTION-LEDGER-SPEC.md. Pure
// observability: every function here swallows its own failure and returns, so it
// can never reach the trading path.
//
// The require itself was the one exception to that promise. rejection_log.js was
// untracked from the day it was written until 2026-08-07, so this line ran only
// because the file happened to sit on the same disk — deploying index.js to the VPS
// carried the require and not the file, and the server died on boot with
// MODULE_NOT_FOUND. Every fresh checkout of this branch had the same dead server.
//
// Observability degrades to silence; it does not take the process down. A missing or
// broken ledger now falls back to no-ops of the same shape and says so loudly.
// Near-miss census — see server/near_miss.js. Counts setups that ALMOST formed, which
// no gate can see because they die BEFORE a setup exists. Guarded like every other
// observability module here, and for the reason spelled out above: index.js is patched
// by hand onto the VPS, so a require whose file did not travel with it kills the box
// that trades continuously. In memory only; it opens no file and votes on nothing.
let noteNearMiss, nearMissCensus;
try {
  ({ noteNearMiss, nearMissCensus } = require("./near_miss"));
} catch (nearMissError) {
  console.error(
    `[near-miss] census unavailable (${nearMissError.message}) — /api/near-miss will ` +
    `report unavailable. Signals and trading are unaffected.`
  );
  noteNearMiss   = () => false;
  nearMissCensus = () => ({
    available: false,
    reason: "server/near_miss.js is not deployed on this box",
    feedsTheGate: false,
  });
}

let logGateRejection, noteGatePass, gateStats, GATE_NAMES, countersStartedAt;
try {
  ({ logGateRejection, noteGatePass, gateStats, GATE_NAMES, countersStartedAt } =
    require("./rejection_log"));
} catch (ledgerError) {
  console.error(
    `[rejections] LEDGER UNAVAILABLE (${ledgerError.message}) — the server is running ` +
    `WITHOUT rejection logging. Gate kills will not be recorded and /api/rejections ` +
    `will reject every row. Trading is unaffected.`
  );
  logGateRejection  = () => false;
  noteGatePass      = () => {};
  gateStats         = {};
  GATE_NAMES        = [];
  countersStartedAt = new Date().toISOString();
}

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
  // Peer liveness between the two boxes. The POST carries AGENT_RELAY_SECRET; the
  // GET only reports which box last checked in and how long ago, which is the thing
  // a health check needs to read without a browser session.
  "/api/peer-heartbeat",
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
  // Raw OHLC for offline analysis. Session-free for the same reason as the line
  // above — no browser is involved — and separately requireLocalOnly on the route,
  // which is the control that matters on an internet-facing box.
  "/api/mt5/candles/raw",
  // Bridge-side gate rejections. Session-free because the bridge has no browser,
  // and requireLocalOnly on the route itself for the same reason /api/mt5/candles
  // carries it. Append-only observability: it writes a log file and touches no
  // signal, position or setting.
  "/api/rejections",
]);

// Paths the MT5 bridge must READ without a browser session, but which must never
// be WRITABLE without one. /api/mt5/control is the remote kill switch: an
// unauthenticated POST there could RESUME trading after a safety halt, and this
// server is reachable from the internet on the VPS. Read freely, write only when
// logged in.
const API_NO_LOGIN_GET_ONLY = new Set([
  "/api/mt5/control",
  "/api/strategy-settings",
  // The only source of per-setup win rate and confidence calibration, and the MCP
  // tools have no browser session — so get_performance returned
  // setups: {"error":"Not logged in."} and /daily STEP 3 has never once had data.
  // Read-only aggregate: setup names, win rates, P&L sums, confidence tiers. No
  // keys, no account numbers, no open positions. There is no POST at this path,
  // and if one is ever added it stays behind the session check.
  "/api/stats/by-setup",
  // Per-gate kill/pass counts. The MCP tools and tasks/gate_health.cjs carry no
  // browser cookie, and this is aggregate diagnostic data: gate names and two
  // integers each. No keys, no account numbers, no positions, no levels. The POST
  // that writes rejections lives at /api/rejections and is separately
  // requireLocalOnly — there is no POST at this path.
  "/api/gate-health",
  // Setups that almost formed, counted in memory. Strictly less sensitive than the
  // line above: a row is a setup name, a condition name, an RSI reading and a count,
  // and the RSI is already published unauthenticated on /api/signals. No keys, no
  // account numbers, no positions, no levels. There is no POST at this path — the
  // census has no write route at all, only the engine increments it.
  "/api/near-miss",
  // Fair Value Gap zones, derived from the same bars /api/signals already exposes
  // publicly. Read-only geometry: price bands and how far price has eaten into
  // them. Nothing here is not already implied by the candles. No POST at this path.
  "/api/fvg",
  // Per-gate verdicts from the scored rejection ledger. Aggregate only: gate
  // names, counts and R sums over setups the gates already threw away. The POST
  // that WRITES rejections is /api/rejections and stays separately
  // requireLocalOnly — there is no POST at this path.
  "/api/rejection-evidence",
  // AI Brain catalogue and the measured-claims register. Both are descriptions of
  // this repo's own contents — skill names, agent names, tool names, and
  // conclusions already written into commit messages. No keys, no positions, no
  // levels. Neither has a POST.
  "/api/ai-registry",
  "/api/evidence-board",
  // Daily evidence-accumulation curve, derived from the scored ledger. Counts and
  // dates only. No POST at this path.
  "/api/learning-growth",
  // AI job health and unreviewed proposals, read from the logs those jobs already
  // write. Decisions are recorded by tasks/ai_decide.cjs, not over HTTP — there is
  // no POST at this path.
  "/api/ai-work",
]);

// The PAGES that may be served without a session. Exact matches only — never a
// prefix — so a new file under /dashboard cannot become public by accident.
//
// WHY THIS SET HAD TO EXIST. /investment carries a comment directly above its route
// declaring it public, and whoever wrote it did the work to make that true: it reads
// only /api/signals, /api/strategy-settings and /api/evidence-board, and all three
// already answer 200 with no cookie (deliberately NOT /api/risk-status, which returns
// the MT5 login in its account config). But the gate below allowlisted API paths only,
// and every non-/api/ path fell through to the redirect — so no page could be public
// no matter what its comment said, and the marketing and investment pages have never
// once been reachable. The intent was written down and nothing read it.
//
// SCOPE, deliberately tiny: two static marketing pages, their direct static filenames,
// and the shared stylesheet they both link. No API is added here; the three these pages
// call were already public before this existed. Everything under /dashboard stays
// gated, and a typo in this set can only fail CLOSED — an unmatched path redirects.
const PAGES_NO_LOGIN_REQUIRED = new Set([
  "/",
  "/index.html",
  "/investment",
  "/investment.html",
  // Linked by both pages. A stylesheet carries no data, and without it a public page
  // renders unstyled, which looks broken rather than gated.
  "/dashboard/theme.css",
  // Same reasoning. An icon carries no data either, and a public page whose favicon
  // 302s to /login shows a blank tab — which reads as a dead site, not a secured one.
  "/dashboard/favicon.svg",
]);

app.use((req, res, next) => {
  if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) return next(); // not configured yet — never lock the owner out
  if (req.path === "/login") return next();
  if (req.method === "GET" && PAGES_NO_LOGIN_REQUIRED.has(req.path)) return next();
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
// Wrapped at BOTH construction sites. wrapAnthropicWithCliFallback is a hoisted
// function declaration so it is callable here; the constants it reads are only
// touched when a request actually fails, long after module init.
let anthropic = ANTHROPIC_API_KEY ? wrapAnthropicWithCliFallback(new Anthropic({ apiKey: ANTHROPIC_API_KEY })) : null;
function reloadAnthropicClient() {
  ANTHROPIC_API_KEY = loadApiKey();
  anthropic = ANTHROPIC_API_KEY ? wrapAnthropicWithCliFallback(new Anthropic({ apiKey: ANTHROPIC_API_KEY })) : null;
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
// Broker contract specs keyed by MT5 symbol, pushed by the bridge alongside the
// candles. Sizing has no MT5 access of its own and cannot guess these: XAUUSD is
// 100 oz per lot and the account settles in GBP, so one lot moves 74.33 per point,
// not 1. Populated on every candle push (60s), empty until the first one lands.
let mt5SymbolSpecs = {};

// Guards the candle-ingest recompute against overlapping with itself. Three assets
// arrive in one payload and a refresh takes ~15s; without this, a bridge restart
// could stack refreshes on top of each other.
let signalRefreshInFlight = false;

// Serialises EVERY caller of the refresh. The flag above only ever guarded the
// candle-ingest path against itself, while refreshSignals is called from six places.
// Two passes running concurrently means last-writer-wins on signalCache, per asset,
// decided by network latency.
//
// That is not theoretical. On 2026-08-06 the server booted with an empty candle cache
// so its startup pass took the slow Yahoo path; the bridge pushed candles seconds
// later and the flip handler started a second pass that wrote gold=mt5 conf 0; then
// the boot pass's GC=F fetch - the slowest call in either pass - resolved and
// overwrote gold with yahoo conf 74. Gold then served futures-derived levels while the
// account fills spot, which is precisely the ambiguity dataSource exists to stop.
//
// Chained, NOT coalesced: a caller must never join an in-flight pass, because the
// candle-flip trigger exists specifically to recompute with bars the running pass did
// not have. The .catch keeps one failed refresh from breaking the chain forever.
let signalRefreshChain = Promise.resolve();
function queueSignalRefresh() {
  signalRefreshChain = signalRefreshChain
    .catch(() => {})
    .then(() => refreshSignals());
  return signalRefreshChain;
}

// Yahoo tickers the signal engine is written against → asset keys used everywhere
// else. Declared once so the ingest endpoint and refreshSignals agree; a mismatch
// here would silently route XAUUSD bars into the BTC signal.
const ASSET_KEY_BY_TICKER = { "BTC-USD": "btc", "GC=F": "gold", "^GSPC": "spx" };

// A daily series shorter than this leaves ema200 null, which pins `trend` to
// "MIXED" and makes MOMENTUM, BREAKOUT and TREND_FOLLOW unreachable — the exact
// starvation that DAILY_RANGE_BY_SYMBOL exists to work around on the Yahoo path.
// Rather than repeat that bug with a new data source, short MT5 series are refused
// and the asset falls back to Yahoo.
// m15 added 2026-08-25. NOT on the signal path: generateSignalMTF reads d1/h4/h1
// and nothing consumes m15. It is carried so tasks/history/*_M15.csv can be topped
// up from the bridge push instead of needing export_mt5_history.py and a flat book,
// which is why those files froze at 2026-07-26 while a position stayed open.
//
// The floor is low on purpose: a short m15 series is still useful for a top-up,
// and unlike d1 it cannot starve an indicator because no indicator reads it.
const MT5_MIN_BARS = { d1: 200, h4: 50, h1: 50, m15: 50 };

// Past this age the bridge is assumed down or wedged and Yahoo takes over. Signals
// refresh far more often than this, so a healthy bridge never comes close.
const MT5_CANDLE_MAX_AGE_MS = 15 * 60 * 1000;

// The R:R shadow log used to live here as an inline logRrRejection() writing to
// tasks/rr_rejected.jsonl. It has been superseded by server/rejection_log.js, which
// records every gate rather than just this one, under the shared schema in
// tasks/REJECTION-LEDGER-SPEC.md.
//
// tasks/rr_rejected.jsonl is FROZEN, not migrated: it holds real evidence written
// under the old schema (11 rows on the laptop, 8 on the VPS) and the scorer reads
// both files and normalises. Nothing appends to it any more — that is the point of
// deleting the writer rather than repointing it.
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
// Names that mean "there was no setup", not "the setup was called this".
//
// `setup` and `signal` are separate fields, so a real row can read
// setup:"MOMENTUM" signal:"WAIT". A row where the SETUP itself is "WAIT" is the
// fingerprint of the H4-only naming bug (fixed in 1047a20), where the setup name was
// taken from the daily leg while the trade came from H4. One such row is sitting in
// the journal right now — the open Gold BUY #1713655080, opened 2026-08-05 — and it
// would have created a tracked setup called "WAIT" the moment it closed.
//
// That matters beyond tidiness: getLearningBoost reads this table, so once a phantom
// setup reaches 5 closed trades it starts adjusting live confidence using the pooled
// result of unrelated trades. Refusing the attribution is strictly better than
// inventing one — the trade's P&L is still recorded in the journal either way.
const NON_SETUP_NAMES = new Set(["WAIT", "NONE", "UNKNOWN"]);

function updateLearning(setup, pnl) {
  if (!setup || pnl === null || pnl === undefined) return;
  if (NON_SETUP_NAMES.has(String(setup).trim().toUpperCase())) {
    console.warn(
      `[learning] REFUSED to attribute a closed trade to "${setup}" — that is the ` +
      `absence of a setup, not a setup. P&L ${pnl} stays in the journal but is not ` +
      `learned from. A row like this means the setup name was lost upstream.`
    );
    return;
  }
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
// PROCESS starts, not trading sessions. This increments once per server boot, so it
// counts restarts — it went 195 -> 197 inside an hour of restarts on 2026-08-17 — and it
// has nothing to do with ASIAN/LONDON/NEW YORK. The name invites the wrong reading, and
// the evidence register already had to warn that quoting it as a sample would raise an
// item that can never clear. Acting on morning-4lvhht, proposed 2026-08-12.
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
  // Minimum RSI on the signal's own timeframe for an entry to be allowed at all.
  //
  // DEFAULT 0 = OFF, deliberately. Measured 2026-08-03 across 2381 replayed trades
  // (2021-09..2026-07): entries below RSI 50 account for 459 closed trades worth
  // -78.4R, while the remaining 1796 make +159.9R at PF 1.22 — and the split
  // improves all four time quartiles, so it is not one lucky stretch. That is the
  // whole reason the book's overall expectancy (0.036R) sits under its own cost
  // assumption (0.05R).
  //
  // It ships OFF because turning it on removes roughly a fifth of all signals, and
  // that number comes from a replay, not from live fills. Set it only after
  // tasks/rsi_walkforward.cjs shows a value positive in most out-of-sample folds.
  minEntryRsi: { min: 0, max: 60, def: 0 },
  // A separate, higher confidence floor for the DAILY_ONLY_H4_NEUTRAL cohort —
  // a daily signal firing while the 4H is neutral.
  //
  // DEFAULT 0 = OFF (the cohort uses the normal gate, i.e. today's behaviour).
  //
  // Measured 2026-08-03 on the live MTF path: that cohort is -41.2R over 113
  // closed at PF 0.56, almost the mirror image of H4_ONLY at +44.8R over 478.
  // Nearly all the book's profit comes from H4-only entries and an equal amount
  // is handed back by daily-only ones. Two independent methods agreed — the
  // byCohort axis and the loss-autopsy analyst, which had no knowledge of it.
  //
  // Expressed as a floor rather than an on/off switch because the analysts'
  // proposal was "suppress OR require materially higher confidence", and a number
  // covers both: 0 is off, a value above the cohort's ceiling suppresses it
  // outright. Those ceilings are 55 on BTC and SPX and 74 on Gold, so 75+
  // suppresses everywhere while 60 mutes BTC/SPX and keeps Gold's top end.
  //
  // This matters MORE since the gate moved to 50: at 70 the cohort could not fire
  // on BTC or SPX at all, and now it can.
  dailyOnlyMinConfidence: { min: 0, max: 100, def: 0 },
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
  minEntryRsi:            STRATEGY_LIMITS.minEntryRsi.def,
  dailyOnlyMinConfidence: STRATEGY_LIMITS.dailyOnlyMinConfidence.def,
  minStrength:            "MODERATE",
  // Scale 50% out at 1R and move the stop to breakeven. FALSE is not a new
  // restriction - it is the behaviour every trade in this journal was managed
  // under. take_partial_profit (mt5_bridge.py:2093) could not fire while
  // fixedLotSize was 0.01, because half of one minimum lot is not tradable, and
  // on 2026-08-24 the size moved to 0.02 and armed it as a side effect of a
  // lot-size edit. Nobody chose that. Boolean, not a number, so it is handled
  // beside minStrength rather than through clampStrategyValue.
  partialCloseEnabled:    false,
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

// Say out loud which signal cohorts cannot reach the current gate.
//
// The engine expresses "this cohort has poor edge" as a low confidence number rather
// than an explicit block, so moving confidenceThreshold silently kills cohorts. It
// has happened three times; the most recent was 65 -> 70 on 2026-08-02, which killed
// BTC H4-only MODERATE (ceiling 65) without a word. A dead cohort makes no trades, so
// it writes nothing to the journal, nothing to the learning table and no error — it
// is indistinguishable from a quiet market.
//
// Reports only. It must never change a signal, and a fault here must never stop the
// server booting: an unreadable table is a lost warning, not a reason to stop
// trading. Called at load and again on every settings change, because a gate edit
// from the dashboard is the exact moment a cohort dies.
function reportCohortReachability(context) {
  try {
    // dailyOnlyMinConfidence is a real gate for the neutral-H4 cohorts — the engine
    // uses max(confidenceThreshold, cohortFloor) at index.js:1721, not the threshold
    // alone. Measuring against the threshold only would call those cohorts alive at
    // the moment a dashboard edit killed them.
    const rows = cohortTable.computeReachability(
      strategySettings.confidenceThreshold,
      strategySettings.dailyOnlyMinConfidence
    );

    // Validate the table against the engine BEFORE trusting its verdicts. Without
    // this the boot log announces conclusions from a table that may no longer
    // describe the code beside it — the audit script checked this and the server,
    // which is what anyone actually reads, did not.
    try {
      const drifted = cohortTable.findTableDrift(fs.readFileSync(__filename, 'utf8'));
      for (const row of drifted) {
        console.warn(`[cohorts] ⚠ TABLE DRIFT: "${row.name}" no longer matches this file (missing: ${row.missing.join(' | ')})`);
      }
      if (drifted.length > 0) console.warn('[cohorts]   Verdicts below may be wrong. Fix server/cohort_table.js.');
    } catch (driftErr) {
      console.warn(`[cohorts] could not verify table against source (${driftErr?.message ?? String(driftErr)})`);
    }

    const dead = rows.filter(row => row.status === 'DEAD');
    if (dead.length === 0) {
      console.log(`[cohorts] ${context}: all ${rows.length} cohorts can reach their gate`);
      return;
    }
    console.warn(
      `[cohorts] ⚠ ${context}: ${dead.length} of ${rows.length} cohort(s) CANNOT reach their gate ` +
      `even at maximum boost (+${cohortTable.MAX_BOOST}). ` +
      `They will never fire and will look like a quiet market:`
    );
    for (const row of dead) {
      const capNote = row.cappedByEngine ? `, capped by the engine at ${row.ceiling}` : '';
      console.warn(`[cohorts]   ${row.name} — base ${row.base}, ceiling ${row.ceiling}${capNote}, ${row.short} short of gate ${row.effectiveGate}`);
    }
    console.warn('[cohorts]   Run `node tasks/cohort_reachability.cjs` for the full table.');
  } catch (e) {
    // A thrown non-Error has no .message, and dereferencing it here would make the
    // catch itself throw — killing boot at startup, and hanging the settings request
    // after the setting had already been saved. A lost warning must never do that.
    console.error(`[cohorts] reachability check failed (${e?.message ?? String(e)}) — continuing`);
  }
}

loadStrategySettings();
reportCohortReachability('startup');

// ══════════════════════════════════════════════════════════════
//  TECHNICAL ANALYSIS
// ══════════════════════════════════════════════════════════════

// SMA-seeded, because seeding on a single close leaves that one bar inside the
// answer for a very long time. The residual weight of the seed after n bars is
// (1 - 2/(period+1))^n, so for EMA200:
//
//     145 bars (Yahoo 210d)  23.5% of the value is still the oldest close
//     205 bars (Yahoo 300d)  12.9%
//     300 bars (MT5 bridge)   5.0%
//     600 bars                0.25%
//
// Measured 2026-08-09 against a converged reference: Gold's EMA200 was +$111 out
// on the Yahoo path and +$21 on the MT5 path, and the price-above-or-below-EMA200
// call — which drives trend classification — disagreed with the converged value
// on 1.3-2.3% of days. Seeding on the mean of the first `period` closes removes
// almost all of that without needing more history.
//
// SMA seeding is ONLY used when there is real runway behind it, and that
// condition is not cosmetic — measured against a converged reference on
// 2026-08-09, seeding on an SMA with too little history is WORSE than seeding on
// a single close:
//
//   bars   GOLD closes[0] err   GOLD SMA err      BTC closes[0]   BTC SMA
//    300        +21.22            -50.16             +254           +672
//    400         +2.87             -6.34             +256           +867
//    600         +0.41             +0.02              +67            +20
//
// The reason is runway. With 300 bars and period 200 the SMA seed leaves only 100
// recursion steps, so 37% of the answer is still an average of 200 OLD closes —
// a heavy drag in a trend. Seeding on closes[0] gets all 300 steps and tracks
// recent price better despite starting from a worse guess.
//
// So the real fix for EMA accuracy is BAR COUNT, not seeding: DAILY_RANGE_* and
// mt5_bridge.py BAR_COUNT_BY_TIMEFRAME were both raised alongside this. Past
// 3x the period the two methods agree to within a rounding error and SMA is
// marginally better, so that is where the switch sits.
const EMA_SMA_SEED_MIN_MULTIPLE = 3;
function emaSeries(closes, period) {
  const k = 2 / (period + 1);
  if (closes.length < period * EMA_SMA_SEED_MIN_MULTIPLE) {
    const short = [closes[0]];
    for (let i = 1; i < closes.length; i++) short.push(closes[i] * k + short[i - 1] * (1 - k));
    return short;
  }
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  seed /= period;
  // The first `period` entries are the seed itself: an EMA is not defined before
  // its own period has elapsed, and emitting a rising ramp there would invent
  // structure the data does not contain.
  const out = new Array(period).fill(seed);
  for (let i = period; i < closes.length; i++) out.push(closes[i] * k + out[i - 1] * (1 - k));
  return out;
}

// WILDER'S RSI, not a simple average. Corrected 2026-08-25.
//
// This used to sum gains and losses over the LAST 14 BARS ONLY and divide by 14.
// That is a simple moving average of gains and losses; it is not RSI. Wilder (1978)
// — which is what MT5, TradingView and every published study compute — smooths those
// averages exponentially at alpha = 1/period, seeded on the first `period` bars and
// carried through the ENTIRE series.
//
// Measured on the live D1 cache the day this was found:
//
//     symbol    old      Wilder    error
//     BTCUSD    91.6      85.5     -6.1
//     XAUUSD    81.3      72.3     -9.0
//     SP500     39.1      52.2    +13.1
//
// Six to thirteen points, AND THE SIGN CHANGES. The MOMENTUM ceiling is 72 and
// rsi_ceiling_walkforward sweeps the band in 8-point steps, so the measurement error
// was larger than a whole step of the thing being swept. A simple average also
// whipsaws as bars enter and leave the 14-bar window where Wilder smooths, which is
// the likeliest reason CSCV found the ceiling axis anti-predictive (PBO 60.5%) and
// the entry-RSI floor inverted (95.0%): a threshold cannot be learned on a
// mis-measured, jittery input.
//
// EVERY RSI THRESHOLD IN THIS PROJECT WAS CALIBRATED ON THE OLD NUMBER — the 72/68
// ceilings, "needs RSI below 50", minEntryRsi, the oversold bands. tasks/_replay_mtf
// sandboxes generateSignal out of this same file, so the replays were internally
// consistent with the wrong indicator rather than immune to it. This correction
// re-points all of them and they MUST be re-measured against it, not assumed to
// carry over.
//
// Needs the whole series, not a 14-bar tail: the smoothing has memory, which is the
// entire point of it. O(n) over the bars already in hand, so the cost is nil.
function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  // Seed: the simple average of the first `period` changes. This is the one place a
  // simple mean is correct — Wilder defines the seed that way.
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  // Then smooth forward across every remaining bar.
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  // No down-closes in the whole smoothed history: RSI is 100 by definition. Kept
  // identical to the old behaviour so this branch is not a new one.
  if (avgLoss === 0) return 100;
  // A non-finite value here would propagate silently into every threshold that reads
  // it; null means "not computable" and every caller already handles it.
  const rsi = 100 - 100 / (1 + avgGain / avgLoss);
  if (!Number.isFinite(rsi)) return null;
  return parseFloat(rsi.toFixed(1));
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
function generateSignal(label, ticker, closes, highs, lows, volumes = [], dxyCloses = null, barSource = null) {
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

  // RSI bands for the two trend-continuation setups. These numbers were inline in the
  // conditions below; they are named here so the near-miss census can report the bar it
  // measures against WITHOUT holding a second copy of it. A duplicated threshold is the
  // single most repeated bug in this codebase — the AI filter was the third copy of the
  // confidence gate, dashboard/index.html held five more and command.html another five.
  // Defined INSIDE generateSignal on purpose: tasks/_replay_mtf.cjs extracts this
  // function into a bare vm sandbox, where a module-level constant is undefined and the
  // step throws into a catch that silently erases the whole cohort. That has happened
  // twice already (SIZING_BOOST_MIN_CONFIDENCE, 1131 Gold steps; logRrRejection, 1006).
  // Behaviour is unchanged: same numbers, same comparisons.
  //
  // The two CEILINGS are read from strategySettings when it carries them, using the
  // same guarded pattern as ADX_TRENDING_MIN fifteen lines above — function-local, and
  // `typeof` guarded so the bare vm sandbox falls through to the literal instead of
  // throwing. They stay defined here for exactly the reason in the paragraph above:
  // hoisting them to module scope is the failure that erased 1,131 Gold steps and 1,006
  // more, silently, twice.
  //
  // WHY THEY BECAME READABLE AT ALL. Measured 2026-08-22: 24 of 24 near-misses failed on
  // RSI_ABOVE_CEILING, the closest by 1.5 points. That makes this the binding constraint
  // on how often this system trades — and with the numbers welded shut, no harness could
  // sweep it, so the top blocker was the one thing in the engine defended by opinion
  // rather than evidence. tasks/rsi_ceiling_walkforward.cjs sweeps it now.
  //
  // BEHAVIOUR IS UNCHANGED. strategy_settings.json carries neither key on either box, so
  // both fall through to 72 and 68 — the values that have always been here. This makes
  // the ceiling MEASURABLE; it does not move it, and it must not be moved on anything
  // less than a walk-forward scored on its worst fold.
  const MOMENTUM_RSI_MIN     = 52;
  const MOMENTUM_RSI_MAX     = (typeof strategySettings !== "undefined"
    && Number.isFinite(strategySettings.momentumRsiMax))
    ? strategySettings.momentumRsiMax : 72;
  const TREND_FOLLOW_RSI_MIN = 45;
  const TREND_FOLLOW_RSI_MAX = (typeof strategySettings !== "undefined"
    && Number.isFinite(strategySettings.trendFollowRsiMax))
    ? strategySettings.trendFollowRsiMax : 68;

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
    rsi !== null && rsi > MOMENTUM_RSI_MIN && rsi < MOMENTUM_RSI_MAX &&
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
    rsi !== null && rsi > TREND_FOLLOW_RSI_MIN && rsi < TREND_FOLLOW_RSI_MAX &&
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

    // A WATCH is a NO-TRADE. Explain it like one: without this, a squeeze suppresses
    // the whole diagnosis and the asset reads "breakout imminent" forever while the
    // actual blocker goes unrecorded. Also say what MOMENTUM was still missing, so
    // the reasons array carries the answer and not just the weather.
    const watchMissing = [
      !inUptrend ? "uptrend" : null,
      !(rsi !== null && rsi > MOMENTUM_RSI_MIN && rsi < MOMENTUM_RSI_MAX)
        ? `RSI inside ${MOMENTUM_RSI_MIN}-${MOMENTUM_RSI_MAX} (now ${rsi})` : null,
      !macd?.bullish ? "MACD bullish" : null,
    ].filter(Boolean);
    if (watchMissing.length) {
      reasons.push(`Not tradeable — MOMENTUM still needs: ${watchMissing.join(", ")}`);
    }
    recordNearMisses();
  }

  else {
    // WAIT — explain exactly what's needed to trigger each setup
    const needsUptrend   = !inUptrend   ? `price above EMA200 (${ema200 ? ema200.toFixed(0) : "N/A"})` : null;
    const needsOversold  = rsi !== null && rsi >= 50 ? `RSI below 50 (now ${rsi})` : null;
    const needsMACD      = !macd?.bullish ? `MACD bullish crossover` : null;
    const blockReasons   = [needsUptrend, needsOversold, needsMACD].filter(Boolean);
    // "needs:", not a bare colon. blockReasons is a list of things that are MISSING —
    // needsUptrend/needsOversold/needsMACD above are each the CONDITION STILL REQUIRED,
    // not a reading of the market. Under the old prefix Gold rendered
    // "No setup: RSI below 50 (now 73.2)", which states that RSI is below 50 and then
    // prints 73.2 in the same breath. It had been misreporting that way for a week
    // (visible in tasks/analysis/deep-plan-20260812T181931.json) and it is the first
    // line a human reads when asking why an asset did not fire.
    //
    // The empty case keeps its own wording: with no missing conditions the fallback is
    // "market not at key level", which is a STATE, and "needs: market not at key level"
    // would be the same category error in the opposite direction.
    reasons.push(blockReasons.length > 0
      ? `No setup — needs: ${blockReasons.join(", ")}`
      : `No setup — market not at key level`);
    reasons.push(`Trend: ${trend} | RSI: ${rsi} | BB bandwidth: ${bb?.bandwidth ?? "N/A"}%`);
    if (bb && bb.bandwidth < 15) reasons.push(`BB squeeze forming — breakout setup building`);
    if (volRatio !== null) reasons.push(`Volume ${volRatio}x avg`);

    // ── Near-miss census ──────────────────────────────────────────
    // OBSERVABILITY ONLY. Nothing below assigns setup, signal, entry, stop, target,
    // strength or confidence, and the whole block is wrapped so a fault here can never
    // reach the trading path. See server/near_miss.js for why this is not a rejection
    // row: no setup formed, so REJECTION-LEDGER-SPEC rule 3.1 excludes it by design.
    //
    // Reaching this else means EVERY setup branch failed. So if a setup's non-RSI
    // conditions all pass here, the RSI band is necessarily what killed it — had RSI
    // been in range the branch would have fired and we would not be in this else.
    // That is the whole inference, and it is exact rather than heuristic.
    //
    // typeof-guarded like every other engine-side helper: tasks/_replay_mtf.cjs runs
    // this function in a bare vm sandbox where these bindings do not exist, and an
    // unstubbed reference throws into a catch that silently deletes the entire cohort
    // from every measurement.
    recordNearMisses();
  }

  // Called from the final else AND from the WATCH branch above it. Declared as a
  // function so there is ONE census, not two that drift.
  //
  // WHY THE WATCH BRANCH NEEDS IT: BB_SQUEEZE_WATCH is an `else if` sitting ahead of
  // the final `else`, and the final `else` is where both this census and the
  // "No setup - needs: ..." line live. An asset in a squeeze therefore got
  // "breakout imminent" and NO diagnosis at all. SPX sat exactly there - RSI 52.8
  // inside the MOMENTUM band, failing only on macd.bullish - showing confidence 0
  // with nothing anywhere recording why. A WATCH is a no-trade and must explain
  // itself like any other no-trade.
  function recordNearMisses() {
    try {
      if (typeof noteNearMiss === "function" && rsi !== null) {
        const nearMissBase = {
          symbol:    barSource?.sourceSymbol ?? null,
          timeframe: barSource?.timeframe ?? null,
        };

        // MOMENTUM: inUptrend && aboveEma50 && aboveEma20 && macd.bullish, RSI banded.
        if (inUptrend && aboveEma50 && aboveEma20 && macd?.bullish) {
          if (rsi >= MOMENTUM_RSI_MAX) {
            noteNearMiss({ ...nearMissBase, setup: "MOMENTUM",
              condition: "RSI_ABOVE_CEILING", threshold: MOMENTUM_RSI_MAX, actual: rsi });
          } else if (rsi <= MOMENTUM_RSI_MIN) {
            noteNearMiss({ ...nearMissBase, setup: "MOMENTUM",
              condition: "RSI_BELOW_FLOOR", threshold: MOMENTUM_RSI_MIN, actual: rsi });
          }
        }

        // TREND_FOLLOW: same idea, its own band and its own EMA200 distance rule.
        if ((inUptrend || trend === "MIXED" && aboveEma50 && aboveEma20)
            && macd?.bullish && ema200 && price > ema200 * 1.005) {
          if (rsi >= TREND_FOLLOW_RSI_MAX) {
            noteNearMiss({ ...nearMissBase, setup: "TREND_FOLLOW",
              condition: "RSI_ABOVE_CEILING", threshold: TREND_FOLLOW_RSI_MAX, actual: rsi });
          } else if (rsi <= TREND_FOLLOW_RSI_MIN) {
            noteNearMiss({ ...nearMissBase, setup: "TREND_FOLLOW",
              condition: "RSI_BELOW_FLOOR", threshold: TREND_FOLLOW_RSI_MIN, actual: rsi });
          }
        }
      }
    } catch (nearMissError) {
      console.error("[near-miss] census skipped:", nearMissError.message);
    }
  }

  // ── Minimum R:R gate ─────────────────────────────────────────
  // Rejects the trade, but no longer erases the evidence that a setup existed.
  //
  // This used to overwrite the whole reasons array and null the levels, so a setup
  // missing the bar by 0.05 scored confidence 0 and read exactly like "no setup
  // formed". Gold sat at conf 0 for a full day on 2026-08-06 with one line of
  // explanation, no setup name and no levels - nothing for a human to judge and
  // nothing for the learning engine to see. A near miss and a non-event are not the
  // same fact and must not serialise to the same payload.
  //
  // RISK POLICY IS UNCHANGED: signal still becomes WAIT, so nothing new is tradeable.
  // Only the diagnostics survive.
  //
  // toFixed(2), not toFixed(1): a real 1.45 rendered as "R:R 1.5 below minimum 1.5",
  // a sentence that cannot be true, which is what sent this morning's Gold
  // investigation down the wrong path.
  if (stop !== null && target !== null && signal !== "WAIT") {
    const calcRR = Math.abs(target - entry) / Math.abs(entry - stop);
    if (calcRR < MIN_RR) {
      // typeof-guarded, and so is every other ledger call in this file. This
      // function is extracted TEXTUALLY into a bare vm sandbox by
      // tasks/_replay_mtf.cjs and tasks/_replay_engine.cjs, where a free variable
      // the sandbox does not define is a ReferenceError — the harness catch
      // swallows it and the whole cohort silently disappears from every
      // measurement. That has already happened twice (SIZING_BOOST_MIN_CONFIDENCE,
      // 1131 Gold steps; logRrRejection, 1006). The guard makes a missing binding a
      // no-op instead of a deletion. In the live server the require sits at the top
      // of this file and a failed require crashes at boot, so it is always true
      // here and no evidence is lost.
      if (typeof logGateRejection === "function") logGateRejection({
        gate:      "MIN_RR",
        side:      "engine",
        ticker,
        label,
        // The instrument these levels were priced on. `ticker` is always the Yahoo
        // symbol regardless of feed, so on its own it would mislabel MT5-derived
        // levels - GC=F futures and XAUUSD spot differ by tens of dollars.
        dataSource:   barSource?.dataSource ?? null,
        sourceSymbol: barSource?.sourceSymbol ?? null,
        // Which chart produced this. A daily setup and an H1 setup have completely
        // different hold times, so without this "would it have won" is unanswerable.
        timeframe:    barSource?.timeframe ?? null,
        setup,
        direction: signal,
        entry:     Number(entry.toFixed(2)),
        stop:      Number(stop.toFixed(2)),
        target:    Number(target.toFixed(2)),
        rr:        Number(calcRR.toFixed(3)),
        // The bar it had to clear, and what it actually came in at, so a sweep can
        // ask "what if the bar had been X" without re-deriving anything.
        threshold: MIN_RR,
        actual:    Number(calcRR.toFixed(3)),
        strength,
        // Only variables provably in scope in generateSignal: rsi and trend.
        // confidence, regime and adx live on the MTF wrapper, not here -
        // referencing them would be a ReferenceError that node --check cannot catch
        // and that would take down signal generation for every asset.
        confidence: null,
        trend:     trend ?? null,
        rsi:       rsi ?? null,
        account:   null,
      });
      reasons = [
        `${setup} rejected: R:R ${calcRR.toFixed(2)} below minimum ${MIN_RR} — no trade`,
        `Rejected levels: entry ${entry.toFixed(2)} stop ${stop.toFixed(2)} target ${target.toFixed(2)}`,
        ...reasons,
      ];
      setup = "WAIT"; signal = "WAIT"; strength = "NONE";
      stop = null; target = null;
    } else if (typeof noteGatePass === "function") {
      // The denominator. Rejections alone cannot tell you a gate is dead; a gate
      // with a healthy kill count and zero passes is the alarm.
      noteGatePass("MIN_RR");
    }
  }

  // ── Minimum entry RSI gate ──────────────────────────────────
  // Runs on the signal's own timeframe, after the setups have resolved and before
  // any confidence scoring, so it can only ever remove an entry — never create or
  // promote one. Both directions: the measured population is "entries below RSI N",
  // not "longs below RSI N", and a breakdown short taken into an already-oversold
  // tape lost money the same way a counter-trend long did.
  //
  // Off when minEntryRsi is 0, which is the shipped default. Reading it from
  // strategySettings rather than a constant is what lets the walk-forward vary it;
  // it must NOT be pinned to another setting for the reason GOLD_SQUEEZE_MODERATE_
  // CONFIDENCE is not pinned to confidenceThreshold — the harness moves those and a
  // follower silently leaves the population being measured.
  const minEntryRsi = Number(strategySettings?.minEntryRsi) || 0;
  const entryRsiGateArmed = signal !== "WAIT" && minEntryRsi > 0 && rsi !== null;
  if (entryRsiGateArmed && rsi < minEntryRsi) {
    // Levels recorded here are the ones the gate killed, which is BEFORE the
    // structural-stop block below narrows the stop. That is the correct paper trade
    // for this gate — it is what existed at the moment of the kill — but a scorer
    // must not expect it to match a live fill.
    if (typeof logGateRejection === "function") logGateRejection({
      gate:      "ENTRY_RSI",
      side:      "engine",
      ticker,
      label,
      dataSource:   barSource?.dataSource ?? null,
      sourceSymbol: barSource?.sourceSymbol ?? null,
      timeframe:    barSource?.timeframe ?? null,
      setup,
      direction: signal,
      entry:     Number(entry.toFixed(2)),
      stop:      stop   !== null ? Number(stop.toFixed(2))   : null,
      target:    target !== null ? Number(target.toFixed(2)) : null,
      rr:        (stop !== null && target !== null && entry !== stop)
                   ? Number((Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(3))
                   : null,
      threshold: minEntryRsi,
      actual:    rsi,
      strength,
      confidence: null,
      trend:     trend ?? null,
      rsi,
      account:   null,
    });
    reasons = [`Entry RSI ${rsi} below minimum ${minEntryRsi} — skip`];
    setup = "WAIT"; signal = "WAIT"; strength = "NONE";
    stop = null; target = null;
  } else if (entryRsiGateArmed && typeof noteGatePass === "function") {
    // Only counted while the gate is ARMED. minEntryRsi ships at 0, and counting a
    // pass for a disarmed gate would make the zero-pass alarm unreadable.
    noteGatePass("ENTRY_RSI");
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
function generateSignalMTF(label, ticker, dailyData, h4Data, h1Data = null, dxyDailyCloses = null, barSource = null) {
  const daily = generateSignal(label, ticker, dailyData.closes, dailyData.highs, dailyData.lows, dailyData.volumes ?? [], dxyDailyCloses, { ...(barSource ?? {}), timeframe: "D1" });
  if (!daily) return null;

  // A throw here is NOT the same as "not enough bars" and NOT the same as "H4 had
  // no opinion" — see the h4 === null note in the confidence block below. All three
  // land on null, and only this log tells them apart. Without it a broken helper
  // silently demotes every setup on this ticker to daily-only, drops confidence
  // under the gate, and reads as a quiet market. The fallback is unchanged: null
  // still means "could not compute", so nothing is blocked that would have fired.
  let h4 = null;
  try {
    if (h4Data?.closes?.length >= 50)
      h4 = generateSignal(label, ticker, h4Data.closes, h4Data.highs, h4Data.lows, h4Data.volumes ?? [], null, { ...(barSource ?? {}), timeframe: "H4" });
  } catch (e) {
    console.error(`[signals] ${label} (${ticker}) H4 leg threw — confidence collapses to daily-only 40: ${e && e.message ? e.message : String(e)}`);
  }

  let h1 = null;
  try {
    if (h1Data?.closes?.length >= 50)
      h1 = generateSignal(label, ticker, h1Data.closes, h1Data.highs, h1Data.lows, h1Data.volumes ?? [], null, { ...(barSource ?? {}), timeframe: "H1" });
  } catch (e) {
    // NOT daily-only: h4 is untouched. Only the triple-alignment boost at the
    // `h4 && h1` check below is lost, which is worth up to 16 points (88 -> 72).
    console.error(`[signals] ${label} (${ticker}) H1 leg threw — triple-alignment boost unavailable: ${e && e.message ? e.message : String(e)}`);
  }

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

  // The gate a signal must clear. Normally confidenceThreshold, but the
  // DAILY_ONLY_H4_NEUTRAL cohort can be held to a higher floor of its own — see
  // dailyOnlyMinConfidence in STRATEGY_LIMITS. Math.max, so the cohort floor can
  // only ever be STRICTER than the global gate, never a way to sneak under it.
  // SPX H4-only is blocked by measurement at every legal gate — see
  // SPX_H4_ONLY_BLOCKED_FLOOR. Checked first because it is unconditional: unlike the
  // neutral-H4 floor it is not a setting anyone can turn off from the dashboard.
  const isSpxH4Only = isH4Only && ticker === "^GSPC";
  const cohortFloor = isSpxH4Only ? SPX_H4_ONLY_BLOCKED_FLOOR
    : isDailyNeutralH4
      ? (Number(strategySettings?.dailyOnlyMinConfidence) || 0)
      : 0;
  const effectiveThreshold = Math.max(strategySettings.confidenceThreshold, cohortFloor);

  finalSignal = confidence >= effectiveThreshold ? signalDir : "WAIT";
  // "fires => tradeable" is an invariant. With a fixed 70 here, anything landing
  // 65-69 fired as a real BUY/SELL carrying strength NONE — which mt5_bridge.py
  // drops in AUTO mode, so the signal showed on the dashboard and the trade
  // silently never happened. Deriving strength from finalSignal rather than
  // re-testing a threshold keeps that invariant true no matter which gate applied.
  const finalStrength = finalSignal === "WAIT" ? "NONE"
                      : confidence >= 90 ? "STRONG"
                      : "MODERATE";

  // Market regime
  const bbW = daily.indicators?.bb?.bandwidth;
  const regime =
    (daily.trend === "STRONG UPTREND" || daily.trend === "STRONG DOWNTREND") ? "TRENDING" :
    (bbW && bbW < 8) ? "SQUEEZE" :
    (bbW && bbW > 25) ? "VOLATILE" : "RANGING";

  const finalRR = (refinedStop !== null && refinedTarget !== null)
    ? parseFloat((Math.abs(refinedTarget - daily.entry) / Math.abs(daily.entry - refinedStop)).toFixed(1))
    : daily.rr;

  // ── The signal's final identity, resolved once ───────────────
  // These five expressions were previously written inline in the return object.
  // They are hoisted so the rejection ledger below records EXACTLY the trade this
  // function returns — a second copy of these fallback chains would drift, and a
  // ledger row holding different levels from the signal it describes is worse than
  // no row at all. The expressions themselves are unchanged, so the returned object
  // is byte-for-byte what it was.
  const finalSetup = (isH4Only && h4?.setup) ? h4.setup : daily.setup;
  // Which chart produced the setup above. Without it the name alone cannot say
  // whether a trade was a daily or a 4H entry, and those have completely different
  // hold times.
  const finalSetupTimeframe = isH4Only ? "H4" : "D1";
  // H4-only entries take stop/target from h4 below, so entry has to come from h4
  // too. Spreading ...daily leaves entry on the daily close while the stop sits on
  // the 4H close; when those diverge |entry - stop| collapses, which inflated
  // replayed R:R as far as 24R and — under risk-based sizing, which divides by stop
  // distance — would size the position into the maxLotSize ceiling.
  const finalEntry  = (isH4Only && h4?.entry != null) ? h4.entry : daily.entry;
  const finalStop   = (refinedStop   != null && refinedStop   !== 0) ? parseFloat(refinedStop.toFixed(2))   : (daily.stop   ?? (h4?.stop   != null ? parseFloat(h4.stop.toFixed(2))   : null));
  const finalTarget = (refinedTarget != null && refinedTarget !== 0) ? parseFloat(refinedTarget.toFixed(2)) : (daily.target ?? (h4?.target != null ? parseFloat(h4.target.toFixed(2)) : null));

  // ── Confidence gate ledger — CONFIDENCE and COHORT_FLOOR ─────
  // Reads only. Nothing below assigns to finalSignal, confidence, or any level; the
  // decision was made above and is not revisited here.
  //
  // The two gates are the SAME comparison, and recording them separately is the
  // entire reason this ledger exists. COHORT_FLOOR means the setup cleared the
  // global confidence gate and died on a floor that applies only to its cohort —
  // that is precisely what hid Gold's DAILY_ONLY_H4_NEUTRAL cohort, which sat
  // capped at 74 against a floor of 75 for 1131 steps with nothing reporting it.
  // Rolled together, that reads as "the confidence gate is working".
  //
  // Only a setup that FORMED is logged: signalDir is "WAIT" on a BOTH_WAIT step,
  // and XAUUSD alone has 3799 of those in a 5-year replay.
  if (signalDir === "BUY" || signalDir === "SELL") {
    const cohortFloorDecided = effectiveThreshold > strategySettings.confidenceThreshold;
    const clearedGlobalGate  = confidence >= strategySettings.confidenceThreshold;
    const gateUnderTest = (cohortFloorDecided && clearedGlobalGate) ? "COHORT_FLOOR" : "CONFIDENCE";
    if (finalSignal === "WAIT") {
      if (typeof logGateRejection === "function") logGateRejection({
        gate:      gateUnderTest,
        side:      "engine",
        ticker,
        label,
        dataSource:   barSource?.dataSource ?? null,
        sourceSymbol: barSource?.sourceSymbol ?? null,
        timeframe:    finalSetupTimeframe,
        setup:     finalSetup,
        direction: signalDir,
        entry:     finalEntry,
        stop:      finalStop,
        target:    finalTarget,
        rr:        finalRR ?? h4?.rr ?? null,
        confidence,
        // The per-timeframe strength that produced this, not finalStrength —
        // finalStrength is "NONE" by definition on anything the gate killed, which
        // would tell a scorer nothing about the setup's quality.
        strength:  signalTf?.strength ?? null,
        threshold: effectiveThreshold,
        actual:    confidence,
        trend:     signalTf?.trend ?? null,
        rsi:       signalTf?.indicators?.rsi ?? null,
        account:   null,
      });
    } else if (typeof noteGatePass === "function") {
      noteGatePass(gateUnderTest);
    }
  }

  return {
    ...daily,
    signal:     finalSignal,
    strength:   finalStrength,
    // The setup that actually produced these levels. On an H4-only entry
    // daily.setup is "WAIT" by definition — that is what isH4Only MEANS — so
    // spreading ...daily named a setup that was never taken, right beside an entry,
    // stop, target, strength and confidence all taken from H4.
    //
    // It is not only cosmetic. getLearningBoost above already reads signalTf.setup,
    // i.e. the H4 name, so the engine was boosting one bucket and journalling the
    // outcome under another: the learning loop could never close for this cohort,
    // and every H4-only trade would have landed in a "WAIT" bucket that describes
    // no setup at all. The live Gold position opened 2026-08-05 is journalled
    // exactly that way — setup "WAIT" with strength "MODERATE" and confidence 70.
    //
    // Same principle entry/stop/target already follow since 910f0ba: every leg of
    // an H4-only trade comes from the H4 timeframe. This changes no gate, no level
    // and no sizing input; nothing in the codebase branches on setup === "WAIT".
    setup:      finalSetup,
    setupTimeframe: finalSetupTimeframe,
    confidence,
    regime,
    entry:      finalEntry,
    stop:       finalStop,
    target:     finalTarget,
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
// 210d is ~145 trading bars, which is fewer bars than the 200-period EMA needs.
// The engine was asking for EMA200 from 145 closes and getting a number that was
// 23% the oldest bar — Gold's EMA200 came out $185 above its converged value on
// that path. Raised to 900d (~620 bars) so EMA200 converges on the FALLBACK path
// too; the per-symbol override stays because GC=F has thinner coverage.
// See emaSeries() for the measurement.
const DAILY_RANGE_DEFAULT = "900d";
const DAILY_RANGE_BY_SYMBOL = { "GC=F": "900d" };

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

// SPX H4-only is BLOCKED BY MEASUREMENT, not by arithmetic.
//
// Its base of 45 reads like a leftover from the gate moving 65 -> 70, and the
// reachability report listed it beside four cohorts that ARE accidents. It is not
// one. Every SPX H4-only slice is negative out of sample — measured 2026-08-11 by
// tasks/cohort_walkforward.cjs over 914 trades, 5 equal-count folds, cost 0.05R:
//
//   SP500/H4_ONLY/STRONG      47 closed  -0.196 R/trade  1/5 folds
//   SP500/H4_ONLY/NONE        28 closed  -0.065          2/5 folds
//   SP500/H4_ONLY/MODERATE    91 closed  -0.039          2/5 folds
//
// which agrees with the held-out result already cited at the isH4Only branch.
//
// Encoding that as a low number was the hazard. confidenceThreshold is settable
// down to 50 (STRATEGY_LIMITS), and this system HAS run at 50 before — at any gate
// from 50 to 60 the cohort's 45 + 15 boost stack clears it and SPX starts trading a
// measured loser, silently, with nothing in the change saying so.
//
// A floor above the maximum attainable confidence blocks it at EVERY legal gate.
// 101 rather than 100 because confidence is clamped to 100 and `>=` would let a
// perfect score through. Deliberately expressed as a cohort FLOOR so it flows
// through the single `confidence >= effectiveThreshold` comparison the ledger block
// depends on — a separate boolean would create a second decision path and break the
// invariant that comment relies on.
//
// This does NOT silence the cohort. logGateRejection fires on signalDir, before the
// gate, so every SPX H4-only setup still lands in the rejection ledger at its TRUE
// confidence and is still walked forward on real bars by the shadow scorer. That is
// the point: if SPX H4-only ever turns positive, the evidence to overturn this is
// still being collected. Re-measure with tasks/cohort_walkforward.cjs before
// removing it.
const SPX_H4_ONLY_BLOCKED_FLOOR = 101;

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
  const { closes, highs, lows, volumes, times, opens } = bars;
  const usable = (series) => Array.isArray(series)
    && series.length >= minBars
    && series.every(v => typeof v === "number" && Number.isFinite(v));
  if (!usable(closes) || !usable(highs) || !usable(lows)) return null;
  if (highs.length !== closes.length || lows.length !== closes.length) return null;
  // Volumes are optional: some brokers report tick_volume only on some symbols.
  // An empty array makes volRatio null and volConfirmed false, which disables the
  // volume-confirmed setups rather than inventing confirmation from zeros.
  const alignedVolumes = (usable(volumes) && volumes.length === closes.length) ? volumes : [];
  // Bar open times, unix seconds. OPTIONAL and must stay optional: a bridge that
  // has not restarted since this shipped sends none, and rejecting those bars
  // would take the live feed down to fix a diagnostic. Absent means the staleness
  // check below cannot run and says so, rather than passing silently.
  const alignedTimes = (usable(times) && times.length === closes.length) ? times : null;
  // Bar OPEN prices. OPTIONAL for exactly the same reason `times` is: a bridge that
  // has not restarted since this shipped sends none, and rejecting those bars would
  // take the live feed down to fix something no indicator reads. Nothing on the
  // signal path consumes opens — they exist so tasks/persist_bars.cjs can write a
  // complete time,open,high,low,close,tick_volume row back to tasks/history without
  // inventing the one column the push was missing. Absent means that writer refuses
  // the series and says so, rather than filling the gap with a guess.
  const alignedOpens = (usable(opens) && opens.length === closes.length) ? opens : null;
  return { closes, highs, lows, volumes: alignedVolumes, times: alignedTimes, opens: alignedOpens };
}

// How old the NEWEST bar may be before the series is stale, per timeframe. Two
// periods of slack: one for the bar still forming, one for weekend and holiday
// gaps, which are normal and must not read as a fault.
const BAR_MAX_AGE_MS = { d1: 4 * 24 * 3600e3, h4: 16 * 3600e3, h1: 5 * 3600e3 };

/**
 * Is this series actually current, judged on the BARS rather than on when the
 * push arrived?
 *
 * This is the gap that made the check worth building. Freshness was decided by
 * `receivedAt` alone — the moment the HTTP POST landed. If MT5 hands the bridge a
 * stale array (the documented failure mode: the terminal restarts underneath a
 * running bridge and calls quietly return nothing useful), the bridge keeps
 * posting on schedule, receivedAt is always seconds old, and the engine computes
 * signals on old prices forever with every health check green.
 *
 * Returns { checked, stale, ageMs, lastBarAt, reason }.
 */
function judgeBarFreshness(bars, timeframe) {
  if (!bars || !Array.isArray(bars.times) || !bars.times.length) {
    return { checked: false, stale: false, ageMs: null, lastBarAt: null,
             reason: "no bar timestamps — bridge predates this check, so staleness is UNVERIFIED" };
  }
  const lastSec = bars.times[bars.times.length - 1];
  const ageMs = Date.now() - lastSec * 1000;
  const limit = BAR_MAX_AGE_MS[timeframe] ?? BAR_MAX_AGE_MS.h1;
  return {
    checked: true,
    stale: ageMs > limit,
    ageMs,
    lastBarAt: new Date(lastSec * 1000).toISOString(),
    reason: ageMs > limit
      ? `newest ${timeframe} bar is ${Math.round(ageMs / 3600e3)}h old, limit ${Math.round(limit / 3600e3)}h`
      : "current",
  };
}

// Returns the MT5 bar set for an asset, or null to mean "use Yahoo". Bars are
// sanitized on ingest, so this only decides freshness and completeness.
function mt5BarsFor(assetKey) {
  const entry = mt5CandleCache[assetKey];
  if (!entry) return null;
  if (Date.now() - new Date(entry.receivedAt).getTime() > MT5_CANDLE_MAX_AGE_MS) return null;
  // Push freshness is not bar freshness. A wedged terminal keeps the push on
  // schedule while the bars stop moving, so the daily series is checked on its own
  // timestamps too. Falls back to Yahoo rather than trading old prices — and only
  // when timestamps are actually present, so a pre-timestamp bridge is unaffected.
  const dailyFreshness = judgeBarFreshness(entry.bars?.d1, "d1");
  if (dailyFreshness.checked && dailyFreshness.stale) {
    if (!mt5BarsFor._warned || Date.now() - mt5BarsFor._warned > 600000) {
      mt5BarsFor._warned = Date.now();
      console.warn(`[mt5] ${assetKey} ${entry.symbol}: STALE BARS — ${dailyFreshness.reason}. `
        + `The push is current (${Math.round((Date.now() - new Date(entry.receivedAt).getTime()) / 1000)}s ago) `
        + `but the data is not. Falling back to Yahoo.`);
    }
    return null;
  }
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
      // barSource carries the instrument these levels were actually computed from.
      // Without it the R:R shadow log records GC=F while holding XAUUSD prices.
      signalCache[a.key] = generateSignalMTF(a.label, a.symbol, dailyData, h4Data, h1Data, dxyForAsset, { dataSource, sourceSymbol });
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
        // WHEN the newest daily bar closed, not merely how many bars arrived. mt5BarsFor()
        // already computes this to decide the Yahoo fallback and then discards it, so a
        // wedged terminal that keeps posting on schedule while its bars stop moving was
        // invisible from this response — the documented failure mode, and the reader had to
        // diff two runs against saved memory to catch it.
        // Proposed by the VPS morning agent, morning-6uy0o7.
        //
        // Judged on the MT5 SERIES ITSELF, not on whether it was used, and this is the
        // whole point. The first cut read `mt5Bars`, which mt5BarsFor() returns as null
        // PRECISELY WHEN the daily series is stale (see its stale branch above) — so
        // `stale` could only ever come back false, and the wedged-terminal case landed on
        // the fallback looking byte-identical to "no bridge is running". A diagnostic whose
        // headline boolean cannot change state is the status-text-nobody-can-move pattern.
        // Reading the cache directly makes stale:true reachable.
        //
        // `stale` stays a statement about the MT5 bars alone. It must NOT be set on the
        // fallback: when Yahoo supplied the levels those prices are genuinely fresh, and a
        // consumer reading stale:true would conclude the served prices were old.
        // `usedForThisSignal` carries that second, separate fact, so "MT5 wedged, fell back"
        // (stale:true, used:false) is distinguishable from "no bridge yet"
        // (checked:false, used:false). Same key set on every branch.
        const mt5Entry = mt5CandleCache[a.key];
        const dailyBarFreshness = mt5Entry
          ? judgeBarFreshness(mt5Entry.bars?.d1, "d1")
          : { checked: false, stale: false, ageMs: null, lastBarAt: null,
              reason: "no MT5 bars have been pushed for this asset yet" };
        signalCache[a.key].barFreshness = {
          ...dailyBarFreshness,
          usedForThisSignal: dataSource === "mt5",
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
  persistSignalChanges();
  try { hermes.runHermesCycle(signalCache, priceCache); } catch (e) { console.error("[hermes] cycle error:", e.message); }
  refreshAnalysis();
}

// Last row actually written per asset, so a signal that stands for hours is stored
// once rather than once per refresh. Reset by a restart, which writes one row per
// asset on the first cycle — that is wanted, because a restart is itself a fact worth
// having in the series.
const lastPersistedSignal = {};

/**
 * Write each asset's signal to SQLite when it MATERIALLY changes.
 *
 * The `signals` table has existed since 2026-07-25 and held ZERO rows. db.insertSignal()
 * is written, exported and documented, and was called from nowhere — a table with no
 * writer, which is the mirror of the setting-with-no-reader this project keeps finding.
 * Meanwhile the only history that existed was `signalHistory`: in memory, capped at 100
 * cycles, so roughly fifty minutes, discarded on every restart.
 *
 * That is the thing this system could least afford to throw away. Its binding constraint
 * is sample size; it computes three signals every refresh and remembered none of them.
 * The rejection ledger captures setups that reached a GATE, but a candidate that never
 * got that far — the confidence drifting 45, 50, 55 under the bar for a week — left no
 * trace at all, and that is precisely the record needed to answer "how close does this
 * ever come".
 *
 * Deduped on (setup, direction, confidence) rather than written every cycle, for the
 * same reason the rejection ledger counts episodes and not rows: one setup standing for
 * six hours is one fact, and storing it 720 times would inflate every future count taken
 * from this table. Expect a few hundred rows a day, not millions.
 *
 * WRITE-ONLY AND INERT. Nothing reads this table to decide anything — no gate, no
 * threshold, no confidence, no sizing. It cannot change what trades.
 */
function persistSignalChanges() {
  for (const key of ["btc", "gold", "spx"]) {
    const sig = signalCache[key];
    if (!sig) continue;
    // A cycle that failed to produce a confidence is not evidence of a quiet market,
    // it is a missing reading, and storing it as 0 would be a lie the table cannot
    // later distinguish from a genuine zero.
    if (sig.confidence === undefined || sig.confidence === null) continue;

    const fingerprint = [sig.setup ?? "", sig.signal ?? "", sig.confidence].join("|");
    if (lastPersistedSignal[key] === fingerprint) continue;

    try {
      const written = db.insertSignal({
        symbol:       sig.sourceSymbol || sig.ticker || key.toUpperCase(),
        direction:    sig.signal,
        setup:        sig.setup,
        confidence:   sig.confidence,
        strength:     sig.strength,
        entry:        sig.entry,
        stop:         sig.stop,
        target:       sig.target,
        generated_at: sig.updatedAt || new Date().toISOString(),
        // Whether this reading CLEARED the live gate. Stored as the engine saw it, so
        // the table can later be read as "how often was it close" without re-deriving
        // a threshold that may have moved since.
        fired:        sig.confidence >= (strategySettings?.confidenceThreshold ?? 70) ? 1 : 0,
      });
      // Only advance the marker on a confirmed write. If the DB is unavailable
      // insertSignal returns null, and moving the marker anyway would silently skip
      // this change forever once the DB came back.
      if (written) lastPersistedSignal[key] = fingerprint;
    } catch (e) {
      // Persistence is observability. It must never interrupt signal generation.
      if (!persistSignalChanges._warned || Date.now() - persistSignalChanges._warned > 600000) {
        persistSignalChanges._warned = Date.now();
        console.error("[signals] could not persist to SQLite:", e.message);
      }
    }
  }
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
      if (!signalCache.btc) await queueSignalRefresh();
      await sendTelegram(chatId, signalToTelegram(signalCache.btc));
    },
    "/gold": async () => {
      if (!signalCache.gold) await queueSignalRefresh();
      await sendTelegram(chatId, signalToTelegram(signalCache.gold));
    },
    "/spx": async () => {
      if (!signalCache.spx) await queueSignalRefresh();
      await sendTelegram(chatId, signalToTelegram(signalCache.spx));
    },
    "/signals": async () => {
      await sendTelegram(chatId, "🔄 Refreshing signals — takes ~15 seconds…");
      await queueSignalRefresh();
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
let telegramPollingChecking = false;

// Telegram refuses getUpdates while a webhook is registered - every call comes back
// 409 Conflict, forever, and the catch in pollTelegram turns that into one console
// line every 3 seconds. Measured on the VPS 2026-08-06: 114 failures in 20 minutes
// against a bot whose webhook points at a Supabase function, meaning inbound commands
// had never reached this server at all and the log was pure noise hiding real errors.
//
// The webhook belongs to a separate integration, so it is NOT deleted here - removing
// it would silently break whatever consumes it. Polling is skipped instead.
//
// Checked at runtime rather than hardcoded or env-gated: if the webhook is ever
// removed, the next call re-checks and polling starts with no code change. That is
// also why the early return does NOT set telegramPollingStarted.
async function ensureTelegramPolling() {
  if (telegramPollingStarted || telegramPollingChecking || !TELEGRAM_TOKEN) return;
  telegramPollingChecking = true;
  try {
    let webhookUrl = "";
    try {
      const info = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`,
        { timeout: 10000 }
      );
      webhookUrl = info.data?.result?.url ?? "";
    } catch (e) {
      // A network blip at boot must not permanently disable inbound commands. Fall
      // through and start polling; pollTelegram's own catch handles a live failure.
      console.error("[telegram] getWebhookInfo failed:", e.message);
    }

    if (webhookUrl) {
      console.log(
        `[telegram] Webhook registered (${webhookUrl}) - getUpdates returns 409 on ` +
        `every call, so polling is disabled. Inbound commands go to that webhook, ` +
        `not to this server. Delete the webhook to re-enable polling here.`
      );
      return;
    }

    telegramPollingStarted = true;
    setInterval(pollTelegram, 3000);
    console.log("[telegram] Polling started");
  } finally {
    telegramPollingChecking = false;
  }
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

// ── Fair Value Gaps ───────────────────────────────────────────
// Unfilled three-candle imbalances per asset, per timeframe.
//
// Computed on demand rather than cached: detection is O(bars) over at most 400
// bars x3 timeframes x3 assets, which is far cheaper than the staleness bugs a
// second cache would introduce. Deliberately NOT wired into confidence or any
// gate — this is an observability layer, and an unmeasured geometry must not
// move a number that sizes a trade.
//
// MT5 bars only. The Yahoo fallback series is a different instrument on Gold
// (COMEX future vs spot), and a gap drawn from futures bars would be at prices
// the traded symbol never visited. Reports the gap honestly instead of quietly
// substituting a feed — see the ~5-minute Yahoo window after any restart.
const FVG_TIMEFRAMES = ["daily", "h4", "h1"];
app.get("/api/fvg", (req, res) => {
  const requested = Number(req.query.maxZones);
  const maxZones = Number.isFinite(requested) && requested > 0 && requested <= 20
    ? Math.floor(requested) : 4;

  const assets = {};
  for (const assetKey of ["btc", "gold", "spx"]) {
    const barSet = mt5BarsFor(assetKey);
    if (!barSet) {
      assets[assetKey] = { available: false, reason: "no fresh MT5 bars", source: null, timeframes: {} };
      continue;
    }
    // The live signal for this asset, so each timeframe can be read against the
    // entry, stop and target actually on the table rather than reported as a
    // bare list of price bands.
    const liveSignal = signalCache[assetKey] || null;
    const timeframes = {};
    for (const timeframe of FVG_TIMEFRAMES) {
      const bars = barSet[timeframe];
      if (!bars) { timeframes[timeframe] = { error: "no bars for this timeframe", zones: [] }; continue; }
      try {
        const detected = fvg.detectFVGs(bars, { maxZones });
        // Read against ALL zones found, not just the capped display list: an
        // obstruction that fell outside the top 4 still obstructs.
        const everything = fvg.detectFVGs(bars, { maxZones: 500 }).zones;
        detected.reading = fvg.interpretZones(liveSignal, everything);
        timeframes[timeframe] = detected;
      } catch (e) {
        // One bad series must not take the whole endpoint down.
        console.error(`[fvg] ${assetKey}/${timeframe}: ${e.message}`);
        timeframes[timeframe] = { error: e.message, zones: [] };
      }
    }
    assets[assetKey] = { available: true, source: "mt5", sourceSymbol: barSet.symbol, timeframes };
  }

  res.json({ assets, minGapRangeFraction: fvg.DEFAULT_MIN_GAP_RANGE_FRACTION, updatedAt: new Date().toISOString() });
});
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
  await queueSignalRefresh();
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

    // What one lot of this symbol is worth per 1.0 of price movement, in account
    // currency. Recorded even when the bars below are rejected: sizing needs it and
    // it does not depend on the candles being usable. Without it the sizer assumed
    // 1.0 and returned a Gold size 74x too large.
    const pointValue = Number(payload?.spec?.valuePerPoint);
    if (Number.isFinite(pointValue) && pointValue > 0) {
      mt5SymbolSpecs[symbol] = {
        valuePerPoint: pointValue,
        contractSize:  Number(payload.spec.contractSize) || null,
        minLot:        Number(payload.spec.minLot) || null,
        lotStep:       Number(payload.spec.lotStep) || null,
        account,
        updatedAt:     new Date().toISOString(),
      };
    }

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
        // OPTIONAL, like times and opens. A bridge that has not restarted since m15
        // shipped sends none, and sanitizeBars returns null for it - which every
        // reader already handles. Nothing on the signal path looks at this.
        m15: sanitizeBars(payload?.bars?.m15, MT5_MIN_BARS.m15),
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
    queueSignalRefresh()
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
      // Bar freshness, judged on the bars rather than on when the push landed.
      // "unverified" is a real answer here, not a missing one.
      barFreshness: entry ? {
        d1: judgeBarFreshness(entry.bars?.d1, "d1"),
        h4: judgeBarFreshness(entry.bars?.h4, "h4"),
        h1: judgeBarFreshness(entry.bars?.h1, "h1"),
      } : null,
    };
  }
  const anyVerified = Object.values(sources).some(s => s.barFreshness && s.barFreshness.d1.checked);
  res.json({
    sources, maxAgeMs: MT5_CANDLE_MAX_AGE_MS, minBars: MT5_MIN_BARS,
    barMaxAgeMs: BAR_MAX_AGE_MS,
    staleDetection: anyVerified ? "active" : "UNVERIFIED — bridge sends no bar timestamps yet",
  });
});

// Raw OHLC out of the in-memory MT5 cache, for offline analysis of the instrument
// the engine ACTUALLY trades rather than the Yahoo proxy. Every geometry result so
// far was measured on GC=F futures while the engine trades XAUUSD spot, and that
// basis has already produced one phantom signal in this project.
//
// requireLocalOnly: this is a bulk dump of ~1100 bars x 3 symbols and the VPS is
// internet-facing. The same protection the candle POST carries, for the same reason.
app.get("/api/mt5/candles/raw", requireLocalOnly, (req, res) => {
  const wanted = String(req.query.asset || "").toLowerCase();
  const out = {};
  for (const assetKey of Object.keys(mt5CandleCache)) {
    if (wanted && assetKey !== wanted) continue;
    const entry = mt5CandleCache[assetKey];
    if (!entry || !entry.bars) continue;
    out[assetKey] = {
      symbol: entry.symbol,
      receivedAt: entry.receivedAt,
      ageMs: Date.now() - new Date(entry.receivedAt).getTime(),
      bars: entry.bars,
    };
  }
  res.json({ assets: out, note: "oldest-first, as pushed by mt5_bridge.py" });
});

// ── Rejection ledger ──────────────────────────────────────────
// See tasks/REJECTION-LEDGER-SPEC.md. Every gate that kills a fully-priced setup
// leaves a row in tasks/rejections.jsonl; the engine's four gates write directly,
// the bridge's five POST here.

// Kill/pass counts per gate since this process started. Read-only, and derivable
// from the ledger itself — this is a convenience, not a source of truth, which is
// why it is not persisted.
//
// The number that matters is the DENOMINATOR. A gate with a healthy kill count and
// ZERO passes is the alarm: Gold's DAILY_ONLY_H4_NEUTRAL cohort was capped at
// confidence 74 by SIZING_BOOST_MIN_CONFIDENCE - 1 while its floor demanded 75, for
// 1131 steps over months, and nothing anywhere reported it. Rejections alone could
// not have found that; rejections against passes do it immediately.
app.get("/api/gate-health", (_, res) => {
  res.json({ ok: true, since: countersStartedAt, gates: gateStats });
});

// The blind spot BEHIND /api/gate-health. Every gate counted above fires on a setup
// that already FORMED. A condition that stops a setup forming is upstream of all ten,
// so it is invisible here and equally invisible in the rejection ledger — and that is
// why SP500 has never traded: on 2026-08-16 it was STRONG UPTREND, above all EMAs,
// MACD bullish, ADX 22.8, and missed MOMENTUM by 0.7 RSI points.
//
// Deliberately NOT merged into gate-health. That route answers "which gate is firing";
// this one answers "what died before any gate got a vote". Merging them would put a
// number that is not a gate kill into a payload every reader treats as gate kills.
app.get("/api/near-miss", (_, res) => {
  try {
    res.json(nearMissCensus());
  } catch (e) {
    console.error("[near-miss]", e.message);
    res.status(500).json({ available: false, reason: e.message, rows: [], feedsTheGate: false });
  }
});

// The verdict /api/gate-health cannot give. Kill counts say a gate is FIRING;
// only walking the rejections forward says whether it should have. The ledger and
// the scorer already produced that evidence nightly and nothing read it.
//
// Read-only over tasks/rejections_scored.jsonl. Changes no threshold and admits
// no signal — a route that grades the gates is precisely where the ledger's
// "observability must never alter what trades" rule would be easiest to break.
app.get("/api/rejection-evidence", (_, res) => {
  try {
    res.json(rejectionEvidence.buildEvidence());
  } catch (e) {
    console.error("[rejection-evidence]", e.message);
    res.status(500).json({ available: false, reason: e.message, gates: {}, setups: {} });
  }
});

// Is this system ready for real money? Five gates, AND-ed. See
// tasks/go_live_readiness.cjs for what each one means and why none of them is
// weighted against the others.
//
// SESSION-GATED ON PURPOSE, and it is the one evidence surface that is. The
// aggregate numbers are no more revealing than /api/journal, which is public -
// but the UPTIME gate carries the doctor's verbatim finding, and that names which
// components were down and for how long. That is an operational detail about the
// machine rather than a fact about the trading record, so it stays behind the
// login, consistent with the standing decision to keep this stack gated until it
// is stable.
//
// Cached, and single-flighted. tasks/doctor.cjs accumulates its findings in a
// MODULE-LEVEL array that callers reset before use, so two overlapping requests
// would interleave into each other's results and report a mix of the two. The
// in-flight promise makes concurrent callers share one run rather than race it.
let goLiveCache = { at: 0, payload: null };
let goLiveInFlight = null;
const GO_LIVE_TTL_MS = 60_000;

app.get("/api/go-live-readiness", async (_, res) => {
  try {
    if (goLiveCache.payload && Date.now() - goLiveCache.at < GO_LIVE_TTL_MS) {
      return res.json(goLiveCache.payload);
    }
    if (!goLiveInFlight) {
      goLiveInFlight = (async () => {
        // Required here, not at module scope - see the note by the
        // rejection_evidence require for why.
        const readiness = require("../tasks/go_live_readiness.cjs");
        const payload = readiness.assess();
        goLiveCache = { at: Date.now(), payload };
        return payload;
      })().finally(() => { goLiveInFlight = null; });
    }
    res.json(await goLiveInFlight);
  } catch (e) {
    console.error("[go-live-readiness]", e.message);
    // available:false rather than a bare 500, so the page can say "could not
    // measure" instead of rendering an empty checklist that reads as "all clear".
    res.status(500).json({ available: false, reason: e.message, ready: false, gates: [] });
  }
});

// Does the LIVE system trade like the walk-forward that justified its config?
//
// Every threshold here was chosen by replay, and nothing checked whether reality
// then matched. That is the shape of this project's expensive failures — four
// hardcoded copies of the gate, the dashboard on 65 while the engine ran 70, the VPS
// on a different strategy_settings.json off the same commit — none of which any
// health check could see, because every component was individually fine.
//
// Floored on purpose: both comparisons report TOO FEW TO JUDGE until the sample can
// carry a verdict. A tracker that cries divergence at four fills is one you have
// learned to ignore by the time it is right.
app.get("/api/live-vs-replay", (_, res) => {
  try {
    res.json(liveVsReplay.buildLiveVsReplay({
      journal: tradeJournal,
      analysisPath: path.join(__dirname, "..", "tasks", "analysis", "setup-walkforward-latest.json"),
      historyDir: path.join(__dirname, "..", "tasks", "history"),
      symbols: ["XAUUSD", "BTCUSD", "SP500"],
      realizedRFromPrices,
    }));
  } catch (e) {
    // Message stays in the log, not the body: e.message here carries absolute paths
    // from fs errors, which is exactly what the module avoids by using path.basename.
    console.error("[live-vs-replay]", e.message);
    res.status(500).json({
      available: false,
      reason: "live-vs-replay failed — see server log",
      feedsTheGate: false,
    });
  }
});

// What the AI side of this system is MADE OF — 44 skills, 6 agents, the MCP tool
// catalogue and the guardrails. All of it was on disk and none of it was visible
// from the page that runs the AI.
app.get("/api/ai-registry", (_, res) => {
  try {
    res.json(aiRegistry.getRegistry());
  } catch (e) {
    console.error("[ai-registry]", e.message);
    res.status(500).json({ skills: [], agents: [], tools: [], guardrails: [], error: e.message });
  }
});

// Is the system getting smarter, and how fast? P&L growth is blank on one closed
// fill and will stay blank for months, so it cannot answer that. Evidence growth
// can: resolved paper episodes per day, per-setup progress toward the threshold
// that unlocks the live learning engine, and whether the rate is accelerating.
// Did the AI employee show up, did it succeed, and did anyone read what it wrote?
// A failing weekly review and three unreviewed PROPOSED FIX lines were both
// invisible before this. Runs nothing and spends no tokens — it reads the logs
// the jobs already produce.
app.get("/api/ai-work", async (_, res) => {
  try {
    // Verbose task list, so the ledger can check the job it appraises actually has
    // a task, what that task returned, and which of the other scheduled jobs nobody
    // is appraising at all. Degrades to the previous file-only behaviour if the
    // scheduler cannot be read.
    const scheduledTasks = await readScheduledTasksVerbose();
    res.json(aiWorkLedger.build({ scheduledTasks }));
  } catch (e) {
    console.error("[ai-work]", e.message);
    res.status(500).json({ available: false, reason: e.message, jobs: [], proposals: [] });
  }
});

app.get("/api/learning-growth", (_, res) => {
  try {
    res.json(learningGrowth.build());
  } catch (e) {
    console.error("[learning-growth]", e.message);
    res.status(500).json({ available: false, reason: e.message, days: [], setups: [] });
  }
});

// What the system KNOWS versus what it assumes. Curated measured claims joined to
// the live per-gate verdicts, so a number on this dashboard can always be traced
// to whether it was ever tested.
// ── RESEARCH ────────────────────────────────────────────────────────────────
// Everything the measurement side of this project produces used to live only in
// tasks/analysis/*.json and a terminal. That is how the near-miss census sat on
// ZERO pages while owning every near-miss, and it is how a searcher that runs
// unattended at 05:00 every day would have reported to nobody.
//
// Reads the reports the harnesses already write. It runs nothing: a harness takes
// minutes and an HTTP handler that shells one out would hang the dashboard and
// compete with the bridge for CPU on the box that trades. Missing or unreadable
// report = that section reports itself absent, never a blank panel and never a
// zero pretending to be a measurement.
// Takes a LIST of candidate paths because the harnesses do not agree on where they
// write. per_instrument_edge.cjs defaults OUTDIR to tasks/, so its current report is
// tasks/per_instrument_edge.json while an eight-day-old tasks/analysis/
// per-instrument-edge-latest.json sits beside it from another writer. Reading the
// wrong one would have served a stale table as today's — the newest wins, and the
// file's own mtime ships with it so a reader can see the age rather than trust it.
function readReport(candidates) {
  const names = Array.isArray(candidates) ? candidates : [candidates];
  let best = null;
  for (const name of names) {
    try {
      const file = path.isAbsolute(name) ? name : path.join(__dirname, "..", name);
      if (!fs.existsSync(file)) continue;
      const modified = fs.statSync(file).mtimeMs;
      if (best && modified <= best.modified) continue;
      best = { file, modified, parsed: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (e) {
      // A corrupt candidate must not hide a readable one later in the list.
      continue;
    }
  }
  if (!best) return { available: false, reason: "not run yet" };
  return {
    available: true,
    reportFile: path.basename(best.file),
    reportAgeHours: Math.round(((Date.now() - best.modified) / 3600000) * 10) / 10,
    ...best.parsed,
  };
}

// Age of the bar cache every replay reads. A sweep over stale bars returns
// yesterday's answer with today's confidence, and nothing schedules a refresh —
// export_mt5_history.py does it and is referenced only in a comment.
function barCacheAge() {
  const out = { symbols: {}, newest: null, ageDays: null };
  for (const symbol of ["XAUUSD", "BTCUSD", "SP500"]) {
    try {
      const file = path.join(__dirname, "..", "tasks", "history", symbol + "_D1.csv");
      if (!fs.existsSync(file)) { out.symbols[symbol] = null; continue; }
      const text = fs.readFileSync(file, "utf8").trim();
      const lastLine = text.slice(text.lastIndexOf("\n") + 1);
      const stamp = Number(String(lastLine).split(",")[0]);
      if (!Number.isFinite(stamp)) { out.symbols[symbol] = null; continue; }
      out.symbols[symbol] = stamp;
      if (out.newest === null || stamp > out.newest) out.newest = stamp;
    } catch (e) {
      out.symbols[symbol] = null;
    }
  }
  if (out.newest) out.ageDays = Math.floor((Date.now() / 1000 - out.newest) / 86400);
  return out;
}

app.get("/api/research", (_, res) => {
  try {
    res.json({
      generatedAt: new Date().toISOString(),
      backtestHealth: readReport("tasks/analysis/backtest-health-latest.json"),
      strategySearch: readReport("tasks/analysis/strategy-search-latest.json"),
      perInstrument: readReport([
        "tasks/per_instrument_edge.json",
        "tasks/analysis/per-instrument-edge-latest.json",
      ]),
      ceilingSweep: readReport("tasks/analysis/rsi-ceiling-walkforward-latest.json"),
      bars: barCacheAge(),
      // Stated on the payload so a reader never has to infer it from the absence
      // of a POST. Nothing on this route changes what trades.
      feedsTheGate: false,
      readsOnly: "reports already written to tasks/analysis by the harnesses",
    });
  } catch (e) {
    console.error("[research]", e.message);
    res.status(500).json({ error: "research payload failed", detail: String(e.message).slice(0, 200) });
  }
});

app.get("/api/evidence-board", (_, res) => {
  try {
    const register = evidenceRegister.getRegister();
    let gates = {};
    let gateTotals = null;
    try {
      const evidence = rejectionEvidence.buildEvidence();
      gates = evidence.gates || {};
      gateTotals = evidence.totals || null;
    } catch (e) {
      // The curated half must still render if the ledger is unreadable.
      console.error("[evidence-board] gates:", e.message);
    }
    res.json({
      claims: register.claims,
      claimCounts: register.counts,
      curatedNote: register.note,
      // Which curated claims quote a sample that has since moved, and the live sample
      // they were compared against. Surfaced because a detector nothing renders is
      // decoration: the liveconfig claim went stale TWICE (n=1/119 sessions, then
      // n=3/154) while this board displayed it as measured fact to every reader, and
      // the brief handed the same sentence to every agent. The register never rewrites
      // itself — it is curated by design — so this flag is the only thing that says a
      // human needs to look.
      needsRecuration: register.needsRecuration || [],
      liveSample: register.liveSample || null,
      gates,
      gateTotals,
      feedsTheGate: false,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[evidence-board]", e.message);
    res.status(500).json({ claims: [], gates: {}, error: e.message });
  }
});

// Bridge-side rejections. Same protection as /api/mt5/candles — requireLocalOnly,
// since the bridge always runs on the same machine as the server — and in the
// no-login allowlist for the same reason, because the bridge has no browser
// session. Unlike the candle route this one feeds nothing but a log file, so the
// worst a local caller can do is write junk rows; the gate enum below is what stops
// even that.
const REJECTIONS_MAX_ROWS_PER_REQUEST = 500;
const KNOWN_GATE_NAMES = new Set(GATE_NAMES);

app.post("/api/rejections", requireLocalOnly, (req, res) => {
  const body = req.body;
  const rows = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : [body];
  if (!rows.length || rows.some(r => !r || typeof r !== "object")) {
    return res.status(400).json({ ok: false, error: "expected a rejection row, an array of rows, or { rows: [...] }" });
  }
  if (rows.length > REJECTIONS_MAX_ROWS_PER_REQUEST) {
    return res.status(400).json({ ok: false, error: `at most ${REJECTIONS_MAX_ROWS_PER_REQUEST} rows per request` });
  }

  let written = 0;
  const unknownGates = [];
  for (const row of rows) {
    // Validated here as well as inside the ledger so the caller is TOLD which gate
    // name was dropped. A bridge silently posting a typo'd gate would look exactly
    // like a gate that never fires, which is the failure this whole system exists
    // to make impossible.
    if (!KNOWN_GATE_NAMES.has(row.gate)) {
      if (!unknownGates.includes(row.gate)) unknownGates.push(String(row.gate));
      continue;
    }
    // Rows arriving over HTTP are bridge-side unless they say otherwise; nothing
    // in the engine posts to itself.
    if (logGateRejection({ ...row, side: row.side ?? "bridge" })) written++;
  }
  if (unknownGates.length) {
    console.warn(`[rejections] dropped unknown gate(s): ${unknownGates.join(", ")}`);
  }
  // `written` counts lines appended. Rows suppressed by the dedupe (spec §3.2) are
  // not errors and are not counted — a caller re-posting an unchanged setup is
  // behaving correctly.
  res.json({ ok: true, written, received: rows.length, unknownGates });
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

  // Probed, not taken from PATH — see server/python_path.js.
  const PYTHON_BIN = require("./python_path").pythonBinOrDefault();
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

// Broker contract specs, exactly as the bridge reported them, plus what the LIVE
// fixedLotSize actually turns into at this broker. Read-only; session-gated by the
// /api/ rule at :387 like every other data route.
//
// minLot and lotStep have been pushed by the bridge and stored at :3148 since the
// sizing fix, and until this route existed NOTHING read either one — the same
// dead-field shape as the signals table with no writer. They are the only facts that
// answer two questions the dashboard could not: what lot will this symbol really
// trade, and does that size wake take_partial_profit.
//
// The partial arithmetic below MIRRORS mt5_bridge.py:2133-2135 deliberately, floor
// and round in the same order, including where that is uglier than it needs to be.
// A tidier version here would be a second rule that drifts from the one the bridge
// enforces, which is how this codebase ended up with five copies of the confidence
// gate. If that Python changes, change this with it.
app.get("/api/broker-specs", (req, res) => {
  // The lot arithmetic says whether the position CAN be split. This says whether
  // the bridge will actually do it. Reporting the first as "armed" while the
  // second is off would make this page assert a behaviour that is switched off -
  // the same class of lie as the mode cards that wrote localStorage nothing read.
  const partialEnabled = strategySettings.partialCloseEnabled === true;
  // ?lot= previews a size that is NOT saved yet, so the dashboard can show what a
  // typed value would do without keeping its own copy of the arithmetic. Anything
  // unparseable falls back to the live setting rather than to a guess.
  const previewLot = Number(req.query.lot);
  const usingPreview = Number.isFinite(previewLot) && previewLot >= 0 && req.query.lot !== undefined && req.query.lot !== "";
  const savedLotSize = Number(strategySettings.fixedLotSize) || 0;
  const fixedLotSize = usingPreview ? previewLot : savedLotSize;
  const symbols = {};
  const now = Date.now();

  for (const [mt5Symbol, spec] of Object.entries(mt5SymbolSpecs)) {
    const minLot  = Number(spec.minLot);
    const lotStep = Number(spec.lotStep);
    const haveLotGeometry = Number.isFinite(minLot) && minLot > 0
                         && Number.isFinite(lotStep) && lotStep > 0;

    // fixedLotSize 0 means size from risk, so the lot depends on the stop distance
    // of a trade that does not exist yet. Report unknown rather than a number that
    // would be wrong for every trade but one.
    let effectiveLots = null, flooredUpToMin = null, partial;
    if (!haveLotGeometry) {
      partial = { armed: partialEnabled ? null : false, splittable: null,
                  enabledBySetting: partialEnabled, halfLot: null,
                  why: "broker minLot/lotStep not reported for this symbol" };
    } else if (fixedLotSize <= 0) {
      partial = { armed: partialEnabled ? null : false, splittable: null,
                  enabledBySetting: partialEnabled, halfLot: null,
                  why: partialEnabled
                    ? "fixedLotSize is 0 — size comes from risk, so the lot varies per trade"
                    : "partialCloseEnabled is off" };
    } else {
      // mt5_bridge.py sizing: the broker's floor always wins (see :1140).
      effectiveLots  = Math.max(fixedLotSize, minLot);
      flooredUpToMin = effectiveLots > fixedLotSize;

      // mt5_bridge.py:2133-2135, mirrored.
      let halfLot = Math.floor(effectiveLots / 2 / lotStep) * lotStep;
      halfLot = Number(halfLot.toFixed(8));           // kill float dust, as the bridge does
      const splittable = halfLot >= minLot && halfLot < effectiveLots;
      const armed = splittable && partialEnabled;
      partial = {
        armed,
        splittable,
        enabledBySetting: partialEnabled,
        halfLot,
        why: !partialEnabled
          ? (splittable
              ? `${effectiveLots} lots could be split, but partialCloseEnabled is off - the trailing ladder manages the trade`
              : `partialCloseEnabled is off, and ${effectiveLots} lots could not be split anyway`)
          : armed
          ? `at 1R the bridge closes ${halfLot} of ${effectiveLots} lots and moves the stop to breakeven`
          : `${effectiveLots} lots cannot be split (half is ${halfLot}, broker minimum is ${minLot}) — the trailing ladder manages the trade instead`,
      };
    }

    symbols[mt5Symbol] = {
      valuePerPoint: spec.valuePerPoint ?? null,
      contractSize:  spec.contractSize ?? null,
      minLot:        Number.isFinite(minLot)  ? minLot  : null,
      lotStep:       Number.isFinite(lotStep) ? lotStep : null,
      account:       spec.account ?? null,
      updatedAt:     spec.updatedAt ?? null,
      ageMs:         spec.updatedAt ? now - Date.parse(spec.updatedAt) : null,
      effectiveLots,
      flooredUpToMin,
      partialClose:  partial,
    };
  }

  const available = Object.keys(symbols).length > 0;
  res.json({
    available,
    fixedLotSize,
    savedLotSize,
    partialCloseEnabled: partialEnabled,
    isPreview: usingPreview && previewLot !== savedLotSize,
    symbols,
    // Absent specs are a bridge that has not pushed yet, not a broker without
    // minimums. Say which, so the page shows "unknown" instead of inventing 0.01.
    note: available
      ? "Reported by the bridge on its candle push (~60s). partialClose mirrors mt5_bridge.py:2133-2135."
      : "No bridge has pushed contract specs yet — nothing here is known, and none of it is guessed.",
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

  // Only a real boolean moves this. A truthy string like "false" must not turn
  // scaling-out on, which is exactly what Boolean(incoming.x) would have done.
  if (incoming.partialCloseEnabled !== undefined) {
    if (typeof incoming.partialCloseEnabled === "boolean") {
      strategySettings.partialCloseEnabled = incoming.partialCloseEnabled;
      applied.partialCloseEnabled = incoming.partialCloseEnabled;
    } else {
      rejected.push("partialCloseEnabled must be true or false");
    }
  }

  if (Object.keys(applied).length === 0) {
    return res.status(400).json({ ok: false, error: "No valid settings supplied", rejected });
  }

  strategySettings.updatedAt = new Date().toISOString();
  strategySettings.updatedBy = "dashboard";
  saveStrategySettings();
  console.log(`[strategy] Updated from dashboard: ${JSON.stringify(applied)}`);
  // A gate edit is the exact moment a cohort dies, so say so now rather than at the
  // next restart. Moving 65 -> 70 on 2026-08-02 killed BTC H4-only MODERATE and
  // nothing reported it for six days.
  // dailyOnlyMinConfidence is a real gate too — it raises the bar for the neutral-H4
  // cohorts only (index.js:1718). Watching confidenceThreshold alone would stay
  // silent through the one edit that kills exactly those two cohorts.
  if (applied.confidenceThreshold !== undefined || applied.dailyOnlyMinConfidence !== undefined) {
    reportCohortReachability('gate changed from dashboard');
  }
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

// Shared by /api/performance and /api/checksystem, which compute the same confidence
// calibration and must not be able to disagree about what counts as a reading. It was a
// local const inside /api/performance; the second caller is the reason it is out here.
//
// A trade with NO recorded confidence is not a 0%-confidence trade. Every value
// JavaScript coerces to a finite 0 has to be rejected explicitly, not blacklisted one at
// a time: Number(null), Number(undefined-via-default), Number(""), Number("   "),
// Number(false) and Number([]) are all a finite 0, and Number(true) is 1 — so a boolean
// or an empty array in this field would otherwise score as a real reading. A numeric
// string like "72" is accepted. A confidence of 0 IS legitimate and is kept.
const hasConfidence = (v) => {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v));
  return false;
};

// Performance stats — actual win rate per setup + confidence calibration
app.get("/api/stats/by-setup", (_, res) => {
  const closed = tradeJournal.filter(t => t.status === "CLOSED" && t.pnl !== null);
  if (!closed.length) return res.json({ noData: true, message: "No closed trades yet" });

  // Group by setup.
  //
  // NON_SETUP_NAMES is excluded here for the same reason updateLearning() refuses it:
  // "WAIT" is the ABSENCE of a setup, not a setup. Without this the journal's one
  // WAIT-named filled trade surfaced as its own bucket reading
  // {setup:"WAIT", trades:1, wins:1, winRate:100, avgRealizedR:2.49} — a phantom
  // setup with a perfect record, sorted to the top of the table by winRate. Found by
  // the weekly review on 2026-08-12, which noted that updateLearning already guards
  // this at the point of learning while this endpoint, which is what a human actually
  // reads, did not.
  //
  // They are REPORTED, never dropped. The P&L is real money and belongs on screen;
  // what it must not do is masquerade as a setup's track record. Same shape as the
  // `unattributed` block already served by /api/learning.
  const bySetup = {};
  const unattributedTrades = [];
  for (const t of closed) {
    const rawSetup = String(t.setup || "").trim().toUpperCase();
    if (!t.setup || NON_SETUP_NAMES.has(rawSetup)) {
      unattributedTrades.push({
        id: t.id, symbol: t.symbol, direction: t.direction,
        setup: t.setup || null, pnl: t.pnl, closedAt: t.closedAt || null,
      });
      continue;
    }
    const key = t.setup;
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
  // A trade with NO recorded confidence is not a 0%-confidence trade. `?? 0` sent it
  // into the "<65%" bucket, where it would silently drag that tier's win rate while
  // looking like evidence about low-confidence setups. Both journals happen to carry a
  // confidence on every closed row today, so this is a trap being closed rather than a
  // live corruption being fixed — but the rows that lose a field upstream are exactly
  // the rows that already lost a setup name upstream.
  //
  // Calibration DELIBERATELY still includes trades whose setup name was lost. This
  // measures whether the confidence NUMBER predicts wins, and that number was really
  // produced by the engine regardless of what happened to the setup label. Dropping
  // those rows would discard genuine evidence about calibration.
  // null and undefined must be rejected BEFORE the numeric test: Number(null) is 0 and
  // 0 is finite, so an isFinite check alone lets a null confidence through into the
  // "<65%" tier — which is the very bug this is closing, reintroduced one line later.
  // The same trap produced "stop 0.00" in the deep plan.
  // Every value JavaScript coerces to 0 has to be rejected explicitly, not just null:
  // Number(null), Number(undefined-via-default), Number("") and Number("   ") all
  // produce a finite 0. A legitimate numeric string like "72" is still accepted.
  // hasConfidence now lives at module scope so /api/checksystem shares this exact
  // predicate rather than carrying a second, looser copy of the same idea.
  const scored = closed.filter(t => hasConfidence(t.confidence));
  const unscored = closed.length - scored.length;
  const calibration = tiers.map(tier => {
    const group = scored.filter(t => Number(t.confidence) >= tier.min && Number(t.confidence) <= tier.max);
    const wins  = group.filter(t => t.pnl > 0).length;
    return {
      tier:     tier.label,
      trades:   group.length,
      wins,
      winRate:  group.length > 0 ? parseFloat((wins / group.length * 100).toFixed(1)) : null,
      avgPnl:   group.length > 0 ? parseFloat((group.reduce((s,t) => s + t.pnl, 0) / group.length).toFixed(2)) : null
    };
  }).filter(t => t.trades > 0);

  // totalClosed counts EVERY closed trade, while setupStats now covers only the
  // attributed ones. Stating both, plus the difference, so the two numbers can never be
  // read as disagreeing — the same discipline /api/learning uses for its own split.
  res.json({
    totalClosed: closed.length,
    attributedClosed: closed.length - unattributedTrades.length,
    setupStats,
    calibration,
    // The population behind `calibration`, stated rather than inferred. It is a
    // different population from setupStats: calibration keeps trades whose setup name
    // was lost (the confidence reading is still real) and drops trades with no
    // confidence recorded (there is no reading to calibrate).
    calibrationBasis: {
      scored: scored.length,
      unscored,
      note: unscored
        ? `${unscored} closed trade(s) carry no confidence value and are excluded from the `
          + `tiers — a missing confidence is not a confidence of zero. They remain in `
          + `totalClosed and in setupStats.`
        : "every closed trade carries a confidence value",
      includesUnattributedSetups: true,
    },
    unattributed: {
      count: unattributedTrades.length,
      totalPnl: parseFloat(unattributedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0).toFixed(2)),
      trades: unattributedTrades,
      why: "Closed trades whose setup name is missing or is WAIT/NONE/UNKNOWN. That is the "
         + "absence of a setup, not a setup, so they are excluded from setupStats rather than "
         + "bucketed into a phantom one. Their P&L is real and is counted in totalClosed. "
         + "A row like this means the setup name was lost upstream.",
    },
  });
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
// Must move together with MAX_PLAUSIBLE_RR in tasks/score_rr_rejections.py. The language
// boundary makes one literal impossible, so they are named identically and cross-referenced
// — change one, change the other, or the paper ledger and the live tracker will disagree
// about what counts as an outcome.
const MAX_PLAUSIBLE_RR = 10;

function realizedRFromPrices(direction, entryPrice, stopPrice, closePrice) {
  const prices = [entryPrice, stopPrice, closePrice];
  if (!prices.every(p => typeof p === "number" && Number.isFinite(p))) return null;
  const riskDistance = Math.abs(entryPrice - stopPrice);
  if (riskDistance === 0) return null;
  const isShort  = String(direction || "").toUpperCase().startsWith("S");
  const movement = isShort ? entryPrice - closePrice : closePrice - entryPrice;
  const realizedR = movement / riskDistance;
  // R explodes as the stop collapses toward entry, and this guarded only riskDistance === 0
  // — which is exactly the pre-fix state of the identical formula in the rejection scorer,
  // where ONE row with a $4.21 Bitcoin stop scored +298.56R and inverted the sign of a
  // 498-episode ledger. This function feeds /api/live-vs-replay's totalR over FOUR closed
  // trades, so one artifact would not skew that comparison, it would be it — and comparing
  // live R/trade against replay R/trade is the only thing that tracker exists to do.
  //
  // The engine builds targets at about 2.5x risk and the largest plannedRr in the journal
  // is 6.57, so a realized |R| above 10 means the risk distance was degenerate, not that
  // the trade ran. Symmetric, because -298R is no more real than +298R.
  //
  // null, not 0 and not a clamp: null is already this function's "cannot score" signal, and
  // live_vs_replay.js:208 COUNTS it as unscorable rather than dropping it silently. Nothing
  // is discarded — the trade keeps its P&L, which is measured in money and needs no stop.
  if (!Number.isFinite(realizedR) || Math.abs(realizedR) > MAX_PLAUSIBLE_RR) return null;
  return parseFloat(realizedR.toFixed(2));
}

app.post("/api/trade-opened", async (req, res) => {
  const trade = req.body;
  if (!trade || !trade.ticket) return res.status(400).json({ error: "invalid trade data" });
  console.log(`[trade] Opened: ${trade.type} ${trade.symbol} @ $${trade.price} #${trade.ticket}`);

  // Which signal produced this trade.
  //
  // This used to read signalCache at journal-write time, which is a DIFFERENT moment
  // from the one the trade was decided in. The cache refreshes between a signal
  // firing and the bridge's POST landing, so the journal recorded whatever the cache
  // had moved on to. Both bad rows in the journal came from here: #1682651222 was
  // stamped BB_SQUEEZE_WATCH — a setup that hardcodes signal:"WAIT" at index.js:1139
  // and is skipped as "watch-only, not an entry" at hermes.js:125, so it can never
  // open a trade — and #1713655080 was stamped "WAIT" itself.
  //
  // That name is the bucket key updateLearning() counts under. With one closed trade
  // in the system's history, 100% of the learning data was filed under a setup the
  // engine will never take again.
  //
  // The bridge now sends the signal it actually acted on. The cache is only a
  // fallback, and only when it CORROBORATES the executed direction — an
  // uncorroborated cache records null, because a missing setup is a gap the learning
  // engine can skip whereas a wrong one silently poisons a bucket forever.
  const sigKey = getSignalKeyForSymbol(trade.symbol);
  const sig    = sigKey ? signalCache[sigKey] : null;
  const fromBridge = trade.signalContext && typeof trade.signalContext === "object"
    ? trade.signalContext : null;

  // plannedRr rides the same evidence as the setup. Read from the cache at write
  // time it describes whichever signal happened to be cached then, not this trade's
  // plan — the same defect one line apart.
  let plannedRr = null;
  let signalContext = null;
  if (fromBridge && fromBridge.setup) {
    signalContext = {
      setup:          fromBridge.setup,
      // Carried into the journal so a closed trade says which chart produced it. A
      // daily setup and a 4H setup of the same name are different trades with
      // different hold times, and the learning engine buckets on name alone.
      setupTimeframe: fromBridge.setupTimeframe ?? null,
      confidence:     fromBridge.confidence,
      strength:       fromBridge.strength,
      regime:         fromBridge.regime,
      atr:            fromBridge.atr,
      setupSource:    "bridge",
    };
    plannedRr = Number.isFinite(fromBridge.rr) ? fromBridge.rr : null;
  } else if (sig && sig.setup && sig.signal === trade.type) {
    // Older bridge, or one that had no signal in scope. The cache agrees with the
    // direction actually executed, so it is corroborated evidence rather than a guess.
    signalContext = {
      setup:          sig.setup,
      setupTimeframe: sig.setupTimeframe ?? null,
      confidence:     sig.confidence,
      strength:       sig.strength,
      regime:         sig.regime,
      atr:            sig.atr,
      setupSource:    "cache-corroborated",
    };
    plannedRr = Number.isFinite(sig.rr) ? sig.rr : null;
  } else {
    console.warn(
      `[trade] #${trade.ticket} ${trade.symbol} ${trade.type}: no trustworthy setup. ` +
      `Bridge sent ${fromBridge ? JSON.stringify(fromBridge.setup) : "nothing"}; ` +
      `cache holds ${sig ? `${JSON.stringify(sig.setup)} (signal ${sig.signal})` : "nothing"}. ` +
      `Recording setup null rather than a name this trade did not come from.`
    );
  }

  // A ticket already journalled and still open is a REPEAT of a POST that already
  // succeeded, not a second trade. The bridge cannot tell a slow success from a
  // lost write — it gave up on three of the first four fills while the server
  // finished the work anyway — so any retry it makes must land on an endpoint that
  // cannot double-write. Matched on the account too, because MT5 ticket ids are
  // unique per account and A, B and the VPS all post into this one journal. Only
  // OPEN rows match: a closed row is history and must never absorb a new fill.
  const alreadyJournalled = tradeJournal.find(
    t => t.ticket === trade.ticket
      && t.status === "OPEN"
      && (t.account ?? "default") === (trade.account || "default")
  );
  if (alreadyJournalled) {
    console.log(`[trade] #${trade.ticket} already journalled and open — treating as a repeat POST.`);
    return res.json({ ok: true, duplicate: true });
  }

  // Add to trade journal
  //
  // Written and acknowledged BEFORE the commentary is generated. This used to
  // `await generateTradeCommentary(trade)` first, putting an LLM round trip inside
  // the acknowledgement path: the bridge waits 5s (mt5_bridge.py), the model takes
  // longer, and 3 of the 4 fills in this system's history timed out client-side.
  // They were recorded anyway only because the server kept working after the bridge
  // stopped listening, which is luck. The record is the part that must be durable;
  // the prose is decoration and can arrive late.
  let journalEntry = null;
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
      plannedRr,
      // Filled in after the response by addCommentaryLater(). Present as null from
      // the start so the shape never changes underneath a reader.
      commentary: null
    };
    tradeJournal.unshift(entry);
    if (tradeJournal.length > 200) tradeJournal = tradeJournal.slice(0, 200);
    saveJournal();
    journalEntry = entry;
  }

  // The fill is on disk. Answer the bridge now — everything below is enrichment.
  res.json({ ok: true });

  if (features.autoCommentary) addCommentaryLater(trade, journalEntry);
});

// Generate the commentary for a fill and attach it, after the bridge has already
// been told the trade is recorded.
//
// Deliberately not awaited by the route: nothing here is allowed to delay or fail
// the acknowledgement. It is also the reason this is a named function rather than a
// floating promise — an unhandled rejection terminates Node by default, and this
// process is a trading server, so the catch is load-bearing rather than tidy.
async function addCommentaryLater(trade, journalEntry) {
  // ONE try around everything, not just the model call. After res.json() has gone
  // out there is no request left to fail, so anything that escapes here is an
  // unhandled rejection — and Node terminates the process on those by default.
  // saveJournal() is the realistic thrower: this repo has a history of the journal
  // file being locked mid-write. Losing a paragraph of commentary must never cost
  // the trading server.
  try {
    const commentary = await generateTradeCommentary(trade);
    if (!commentary) return;

    // The entry object is the same one held in tradeJournal, so mutating it IS the
    // update — but only if it is still there. The 200-row cap could in principle
    // have evicted it while the model was thinking, and writing the array back
    // after that would resurrect a dropped row.
    if (journalEntry && tradeJournal.includes(journalEntry)) {
      journalEntry.commentary = commentary;
      saveJournal();
    }

    tvAlerts.unshift({
      id:      Date.now(),
      ts:      new Date().toISOString(),
      ticker:  trade.symbol,
      action:  `${trade.type} OPENED`,
      price:   trade.price,
      message: commentary
    });
    if (tvAlerts.length > 50) tvAlerts = tvAlerts.slice(0, 50);
  } catch (e) {
    console.warn(`[trade] commentary for #${trade.ticket} failed: ${e.message}`);
  }
}

/**
 * Roll today's closed trades into the SQLite `performance` table.
 *
 * db.upsertPerformance() was defined, exported and called from NOWHERE — the
 * `performance` table has held zero rows since it was created, the same dead-wiring
 * as the `signals` table. Without it there is no dated performance series anywhere:
 * the Performance tab recomputes from journal.json on every request, so nothing can
 * answer "what did the curve look like on the 12th" once the journal is trimmed or a
 * setup name is corrected in place.
 *
 * Keyed on the CLOSE date and written with ON CONFLICT DO UPDATE, so re-running it
 * for a day is idempotent — one row per day however many trades close that day, and
 * a late reconciliation of an old close rewrites that day rather than today's.
 *
 * Derived entirely from the journal, which stays the source of truth. Nothing reads
 * this table to decide anything.
 */
function persistDailyPerformance(closeTime) {
  // A close with no timestamp cannot be attributed to a day. Booking it under today
  // would silently move an old outcome onto the current row.
  const day = typeof closeTime === "string" && closeTime.length >= 10
    ? closeTime.slice(0, 10)
    : null;
  if (!day) return;

  try {
    const sameDay = tradeJournal.filter(t =>
      t && t.status === "CLOSED" && typeof t.closeTime === "string"
      && t.closeTime.slice(0, 10) === day && typeof t.pnl === "number");
    if (!sameDay.length) return;

    const wins   = sameDay.filter(t => t.pnl > 0).length;
    const losses = sameDay.length - wins;
    const gross  = sameDay.reduce((sum, t) => sum + t.pnl, 0);

    // Best and worst by TOTAL P&L per setup, not by a single trade, so one outsized
    // fill cannot name a setup that lost money across the day. NON_SETUP_NAMES are
    // excluded for the same reason updateLearning refuses them: "WAIT" is the absence
    // of a setup, and bucketing it invents one.
    const bySetup = {};
    for (const t of sameDay) {
      const setup = t.setup;
      if (!setup || NON_SETUP_NAMES.has(String(setup).toUpperCase())) continue;
      bySetup[setup] = (bySetup[setup] || 0) + t.pnl;
    }
    const ranked = Object.entries(bySetup).sort((a, b) => b[1] - a[1]);

    db.upsertPerformance(day, {
      total_trades: sameDay.length,
      wins,
      losses,
      gross_pnl: Number(gross.toFixed(2)),
      // No commission or swap is recorded per trade, so net cannot be derived and is
      // stored equal to gross rather than invented. Say so here, because a `net_pnl`
      // column that silently equals gross is exactly the kind of number that gets
      // quoted later as if costs had been taken out.
      net_pnl:   Number(gross.toFixed(2)),
      win_rate:  Number(((wins / sameDay.length) * 100).toFixed(1)),
      best_setup:  ranked.length ? ranked[0][0] : null,
      worst_setup: ranked.length ? ranked[ranked.length - 1][0] : null,
    });
  } catch (e) {
    // A rollup failure must never fail the close it was triggered by.
    console.error("[performance] daily rollup failed:", e.message);
  }
}

// MT5 bridge notifies server when a trade is closed
app.post("/api/trade-closed", (req, res) => {
  const { ticket, pnl, closePrice, closeTime, account, exitReason, exitReasonCode,
          mfePrice, maePrice, mfeR, maeR, excursionSamples, excursionIntervalSec,
          excursionSampled } = req.body;
  if (!ticket) return res.status(400).json({ error: "ticket required" });
  // Ticket ids are unique per ACCOUNT, not across the fleet (mt5_bridge.py:1384),
  // and accounts A, B and the VPS all post into this one journal. Prefer the exact
  // pair. The ticket-only fallback is deliberately restricted to entries carrying
  // no account — every entry written before this change — so a close can never be
  // applied to a different account's trade, while old entries still reconcile.
  const trade = tradeJournal.find(t => t.ticket === ticket && t.account === account)
             ?? tradeJournal.find(t => t.ticket === ticket && !t.account);
  if (trade) {
    // Has this outcome already been counted?
    //
    // updateLearning() and db.updateLearning() below are both INCREMENTS, so a
    // second POST for the same ticket books the same win or loss twice and there is
    // no way to tell afterwards. Nothing used to stop that. It matters more now that
    // the bridge sweeps for unsettled trades every RECONCILE_INTERVAL_S instead of
    // once at startup.
    //
    // A close carrying a real P&L on top of one recorded with pnl null is NOT a
    // repeat — track_closed_positions() posts an unknown P&L when it watched a
    // ticket vanish without a closing deal, and that entry was recorded but never
    // scored. Letting the real number land is the whole point of retrying.
    const alreadyScored = trade.status === "CLOSED" && trade.pnl !== null;
    if (alreadyScored) {
      console.log(`[trade] #${ticket} already closed and scored — ignoring repeat close.`);
      return res.json({ ok: true, duplicate: true });
    }

    // Stamp legacy entries so the next close matches on the exact pair.
    if (!trade.account && account) trade.account = account;
    trade.status     = "CLOSED";
    trade.pnl        = pnl       ?? null;
    trade.closePrice = closePrice ?? null;
    trade.closeTime  = closeTime  ?? new Date().toISOString();
    // WHY it closed, straight from MT5's deal record — the journal could not previously
    // tell "hit its stop" from "someone closed it". RECORD ONLY: updateLearning below
    // stays P&L-based and no gate, threshold, confidence or sizing path reads either
    // field. The raw code is kept beside the label so an unrecognised reason is still
    // recoverable rather than flattened into "OTHER" and lost.
    //
    // Assigned ONLY when supplied, never `?? null`. The bridge's reconciliation sweep
    // re-posts closes and does not always carry a reason, so defaulting to null here
    // would erase a reason the live close path had already recorded — deleting evidence
    // on a retry, which is the whole failure mode this journal keeps being bitten by.
    //
    // A STOP is not a loss: a trailing stop moved into profit still closes as
    // DEAL_REASON_SL. Read this alongside pnl, never as a substitute for it.
    if (typeof exitReason === "string" && exitReason) trade.exitReason = exitReason;
    if (Number.isInteger(exitReasonCode)) trade.exitReasonCode = exitReasonCode;

    // How far the trade ran in favour and against before it ended. The journal has
    // never recorded this, which is why "would a breakeven stop have saved this
    // loser" has never been answerable here - only the COST of scaling out at 1R
    // was visible, in winners that finish short of where they would have.
    //
    // SAMPLED at the bridge poll interval, so both are FLOORS, never true extremes.
    // excursionSampled and excursionIntervalSec travel with the numbers so no later
    // reader can mistake a 60s sample for a tick-accurate high-water mark.
    //
    // RECORD ONLY. No gate, threshold, confidence or sizing path reads any of it.
    //
    // Assigned ONLY when supplied, never `?? null`, for the same reason exitReason
    // is: the reconciliation sweep re-posts closes without these fields, and
    // defaulting would erase a record the live close path had already written.
    if (Number.isFinite(mfePrice)) trade.mfePrice = mfePrice;
    if (Number.isFinite(maePrice)) trade.maePrice = maePrice;
    if (Number.isFinite(mfeR))     trade.mfeR     = mfeR;
    if (Number.isFinite(maeR))     trade.maeR     = maeR;
    if (Number.isInteger(excursionSamples))     trade.excursionSamples     = excursionSamples;
    if (Number.isInteger(excursionIntervalSec)) trade.excursionIntervalSec = excursionIntervalSec;
    if (excursionSampled === true)              trade.excursionSampled     = true;

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
    persistDailyPerformance(trade.closeTime);
  }
  console.log(`[trade] Closed: #${ticket}  P&L $${pnl}`);
  res.json({ ok: true });
});

// Trade journal with optional filtering.
//
// Each row is served with `realizedR` alongside its P&L. Dollars are not comparable
// across this journal: one XAUUSD fill was 0.14 lots and the rest are 0.01, so the
// all-time dollar total is dominated by a single trade at 14x the current size and
// says more about a sizing change than about the engine. R is the unit that survives
// that, and the same five fills read -$416.61 and +1.51R.
//
// Derived here rather than in the page. realizedRFromPrices is the server's own
// scorer, shared with /api/live-vs-replay and (via tasks/sizing_trigger.cjs) with the
// go-live gates; a copy in JavaScript on the dashboard would be the fifth, and the
// cost of the copies drifting is a page that disagrees with the readiness verdict
// printed directly above it.
//
// null means "cannot be scored", never 0 — an unscorable trade must not average in as
// a flat outcome. The rows are MAPPED, not mutated: tradeJournal is the in-memory
// journal and writing a derived field onto it would leak into what gets persisted.
app.get("/api/journal", (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const symbol  = (req.query.symbol  || "").toUpperCase();
  const outcome = (req.query.outcome || "").toUpperCase();
  let entries = tradeJournal;
  if (symbol)  entries = entries.filter(t => (t.symbol  || "").toUpperCase() === symbol);
  if (outcome) entries = entries.filter(t => (t.outcome || "").toUpperCase() === outcome);
  const journal = entries.slice(0, limit).map(trade => ({
    ...trade,
    realizedR: trade.closePrice == null
      ? null
      : realizedRFromPrices(trade.direction, trade.entry, trade.sl, trade.closePrice),
  }));
  res.json({ journal });
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
    // Shadow evidence rides ALONGSIDE, never merged in.
    //
    // setupStats counts real fills, and there is exactly one of them in this
    // system's history, so getLearningBoost() can never reach its 5-trade floor.
    // tasks/learning_from_rejections.py walks the rejection ledger forward on real
    // broker bars and produces per-setup outcomes that already have. Until this was
    // exposed here, that evidence was readable by exactly one consumer -- the daily
    // agent, which reads the file directly -- so the dashboard, the MCP get_learning
    // tool and JARVIS itself could not see it at all.
    //
    // Kept as a separate key on purpose. These are forgone PAPER trades: no
    // slippage, no spread, on an entry that was never filled. Folding them into
    // setupStats would make a paper result indistinguishable from a real loss, which
    // is the same class of mistake as the setup mislabelling that put a live -449.72
    // fill under a watch-only setup name. They do NOT feed getLearningBoost().
    let shadow = null;
    try {
      const shadowPath = path.join(__dirname, "learning_shadow.json");
      if (fs.existsSync(shadowPath)) {
        const raw = JSON.parse(fs.readFileSync(shadowPath, "utf8"));
        const generatedAt = raw.generatedAt || null;
        // typeof-guarded, not just Number.isFinite. That catches NaN but not absurdity:
        // a generatedAt of 12345 would parse to a number and render ageHours as
        // -90449006.6 rather than null. Unreachable from the current writer; cheap to
        // make hostile-input-proof.
        //
        // The writer MUST keep emitting an offset. tasks/learning_from_rejections.py uses
        // datetime.now(timezone.utc).isoformat(), which yields "+00:00" — Date.parse reads
        // an offset-LESS ISO string as LOCAL time, so if that ever became utcnow() this
        // laptop would overstate the age by its BST offset while the UTC VPS read it
        // correctly, and the two boxes would disagree by an hour about the same file.
        const generatedMs = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN;
        shadow = {
          stats:       raw.shadowStats || {},
          generatedAt,
          // The AGE, not just the timestamp, because a timestamp makes the reader hold
          // today's date and do the subtraction — and on 2026-08-17 that is precisely what
          // failed. These stats were regenerated at 06:30 UTC, the collapsed-stop R:R cap
          // landed after it, and the shadow went on serving SELL_BOUNCE at +21.38R until
          // someone read generatedAt by hand. A stalled nightly regeneration is now
          // visible from this one response. null when unparseable, never 0 — a zero here
          // would read as "just regenerated", which is the opposite of the truth.
          // Proposed by the VPS morning agent, morning-ny4yxp.
          ageHours: Number.isFinite(generatedMs)
            ? Math.round(((Date.now() - generatedMs) / 3600000) * 10) / 10
            : null,
          whatTheseAre: raw.basis?.whatTheseAre || null,
          feedsTheGate: false,
        };
      }
    } catch (shadowError) {
      // Observability must never take the endpoint down.
      console.error(`[learning] shadow evidence unreadable (${shadowError.message})`);
    }

    // The fills the engine is REFUSING to attribute, stated instead of merely absent.
    //
    // updateLearning() will not put a trade under a name like "WAIT", and that refusal
    // is right: inventing a bucket is worse than admitting a gap, and a phantom setup
    // reaching 5 trades would start adjusting live confidence using the pooled result
    // of unrelated trades. But the SILENCE was wrong. setupStats reads 0 wins and 2
    // losses while the journal holds 3 closed fills including the only WIN this system
    // has ever had (+135.91, 2026-08-05), so anything calibrating off setupStats alone
    // is skewed pessimistic and cannot tell that a win exists.
    //
    // Checked before writing this: the name is genuinely unrecoverable. The bridge log
    // for that fill reads "Gold/XAUUSD - MODERATE BUY (WAIT)" at the moment of
    // execution, so the setup arrived as WAIT in the signal payload itself rather than
    // being lost at journalling. There is nothing to recover and nothing to guess.
    //
    // So it is REPORTED, not attributed. Nothing is written to learning.json, no bucket
    // is created, and getLearningBoost() is untouched — a reader can now see the whole
    // record and which part of it the engine is allowed to learn from.
    const unattributedFills = tradeJournal.filter(t =>
      t && t.status === "CLOSED" && typeof t.pnl === "number" &&
      (!t.setup || NON_SETUP_NAMES.has(String(t.setup).trim().toUpperCase())));
    const attributedCount = Object.values(learning.setupStats)
      .reduce((sum, s) => sum + (s.wins || 0) + (s.losses || 0), 0);
    const closedFills = tradeJournal.filter(t =>
      t && t.status === "CLOSED" && typeof t.pnl === "number").length;

    res.json({
      setupStats: summary,
      sessionCount: learning.sessionCount,
      updatedAt: learning.updatedAt,
      shadow,
      unattributed: {
        count: unattributedFills.length,
        wins: unattributedFills.filter(t => t.pnl > 0).length,
        losses: unattributedFills.filter(t => t.pnl <= 0).length,
        netPnl: +unattributedFills.reduce((sum, t) => sum + t.pnl, 0).toFixed(2),
        fills: unattributedFills.map(t => ({
          symbol: t.symbol, direction: t.direction, pnl: t.pnl,
          openTime: t.openTime, confidence: t.confidence, strength: t.strength,
          regime: t.regime, recordedSetup: t.setup || null,
        })),
        why: "updateLearning refuses to attribute a fill to a name that means "
           + "\"there was no setup\". The name is not recoverable for these: the bridge "
           + "log shows the setup already arrived as WAIT in the signal payload, so it "
           + "was never produced rather than lost. Reported here so the record is "
           + "complete; nothing is written and no bucket is invented.",
      },
      // The one number that says whether the engine can see the whole record.
      reconciliation: {
        closedFills,
        attributedToSetups: attributedCount,
        unattributed: unattributedFills.length,
        complete: closedFills === attributedCount + unattributedFills.length,
      },
      // ALWAYS PRESENT, null when the read succeeded. A field that appears only on
      // failure is one a consumer forgets to check, and cannot distinguish a healthy
      // server from an older one that never emitted it.
      learningError: null,
    });
  } catch (e) {
    // This used to swallow `e` entirely and answer 200 with an empty setupStats,
    // which is byte-identical to a genuinely empty learning file. ELEVEN files read
    // this endpoint — auto_runner.py, commercial/investment.html, dashboard/command
    // and jarvis, debate_agents.py, eod_review.py, market_scanner.py, mcp_server.js,
    // tasks/deep_plan.cjs, tasks/public_pages_test.cjs and tv_daily_plan.py — and not
    // one of them could tell "no learning yet" from "reading it threw". Two of those
    // were fixed on 2026-08-24 for mishandling learning data; this is the same fault
    // one layer up, and it is the fifth instance found that day of a value written
    // correctly and read by nothing.
    //
    // The inner shadow catch two blocks above already had the right shape - log it,
    // keep serving. This now matches it, and adds the field that makes the failure
    // READABLE rather than merely logged where nobody looks.
    //
    // The status stays 200 on purpose. Switching to 500 would change behaviour for
    // all eleven consumers at once and could turn a degraded panel into a broken
    // page; naming the failure in the payload costs them nothing and tells them
    // everything. Same contract as `settingsError` on /api/strategy-settings, which
    // CLAUDE.md already instructs every reader to check first.
    console.error(`[learning] handler failed (${e.message}) — serving an empty payload `
                + `with learningError set; setupStats below is NOT a real reading.`);
    res.json({ setupStats: {}, sessionCount: 0, updatedAt: null, shadow: null,
               unattributed: null, reconciliation: null,
               learningError: e && e.message ? e.message : String(e) });
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

  // The "Equity curve health" block that stood here is gone. It accumulated a local
  // `equity` in a loop whose two branches were the same statement —
  // `if (t.pnl > 0) equity += t.pnl; else equity += t.pnl;` — so the conditional was a
  // no-op, and the variable was never read: not by this handler's res.json, not
  // anywhere in its scope. The other `equity` names in this file belong to
  // /api/equity-curve and the backtest handler and are separate locals.
  //
  // It cost a full walk of the closed journal on every /api/checksystem request for
  // nothing, and an identical-branch conditional reads as a half-written bug, so every
  // future reader had to prove it dead before touching the handler. Removed rather than
  // left as a puzzle.

  // Setup health.
  //
  // An empty setupHealth is indistinguishable from a dead feed, and that ambiguity has
  // real cost: the 2026-08-18, 08-19 (both cycles) and 08-21 summaries each record
  // opening this file to re-derive that {} was CORRECT — the same read four times,
  // because the payload stated the result and withheld the reason. It is empty because
  // every tracked setup currently sits below the sample floor, which is a fact about
  // sample size, not about health.
  const SETUP_HEALTH_MIN_TRADES = 3;
  const setupHealth = {};
  let setupsBelowMinTrades = 0;
  for (const [setup, s] of Object.entries(learning.setupStats)) {
    const total = s.wins + s.losses;
    if (total >= SETUP_HEALTH_MIN_TRADES) {
      const wr = s.wins / total;
      setupHealth[setup] = { wr: parseFloat((wr * 100).toFixed(1)), status: wr > 0.55 ? "GOOD" : wr < 0.4 ? "REVIEW" : "OK" };
    } else {
      setupsBelowMinTrades++;
    }
  }

  // Confidence calibration check
  const tiers = [
    { label: "65-74%", min: 65, max: 74 },
    { label: "75-84%", min: 75, max: 84 },
    { label: "85%+",   min: 85, max: 100 }
  ];
  // Filtered through the same hasConfidence predicate /api/performance uses, so the two
  // calibration tables in this codebase cannot drift apart in what they count.
  //
  // Being precise about what this does and does not fix: `(t.confidence ?? 0)` turned a
  // missing confidence into a 0, but every tier here starts at 65, so a null already
  // fell outside all three and was never mis-bucketed. Unlike /api/performance, which
  // carries a "<65%" tier where exactly that trap DID bite. This closes the trap before
  // anyone adds a low tier here, and — the part that changes today's payload — states
  // the population the tiers were computed from instead of leaving it to be inferred.
  const scoredForCalibration = closed.filter(t => hasConfidence(t.confidence));
  const calibration = tiers.map(tier => {
    const group = scoredForCalibration.filter(t => Number(t.confidence) >= tier.min && Number(t.confidence) <= tier.max);
    const gWins = group.filter(t => t.pnl > 0).length;
    return { tier: tier.label, trades: group.length, winRate: group.length > 0 ? parseFloat((gWins / group.length * 100).toFixed(1)) : null };
  });
  const calibrationTiered = calibration.reduce((sum, t) => sum + t.trades, 0);

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
    learning:    {
      sessionCount:  learning.sessionCount,
      setupsTracked: Object.keys(learning.setupStats).length,
      setupHealth,
      // Why setupHealth may be empty, stated rather than left to be re-derived.
      setupHealthMinTrades: SETUP_HEALTH_MIN_TRADES,
      setupsBelowMinTrades,
    },
    calibration,
    // The population behind `calibration`, so a reader can see when the tiers hold
    // fewer trades than performance.trades in this same response.
    calibrationBasis: {
      scored:   scoredForCalibration.length,
      unscored: closed.length - scoredForCalibration.length,
      tiersCover: "65-100",
      // Trades that carry a real confidence but fall below the lowest tier. Without
      // this, "scored 5, tiers hold 0" looks like a fault rather than five readings
      // that were all under 65.
      scoredBelowTiers: scoredForCalibration.length - calibrationTiered,
    },
    mt5:         { connected: mt5Accounts.some(a => a.connected), accounts: mt5Accounts },
    proposal:    proposal ? { worstSetup: proposal.worstSetup, winRate: proposal.winRate, generatedAt: proposal.generatedAt } : null
  });
});

// Setup health — which setups to prioritise or avoid
app.get("/api/setup-health", (_, res) => {
  res.json({ alerts: checkSetupHealth(), updatedAt: new Date().toISOString() });
});

// Daily plan — structured trade plan for today
/**
 * The measured next-candle read, written by tasks/candle_probability.cjs.
 *
 * Rides ALONGSIDE the signals and never merges with them, for the same reason the
 * shadow ledger does: this is BAR GEOMETRY measured out-of-sample, not a signal and not
 * a fill. It feeds no gate, no confidence and no order — nothing reads it but a human.
 *
 * Carries its own AGE, because a probability with no age is the same trap as a health
 * tick with no age: the file is regenerated by a scheduled run, and a stalled run would
 * otherwise serve last week's read as this morning's with nothing on screen to say so.
 * null when absent, never an empty object that reads as "no edge today".
 */
function readCandleToday() {
  try {
    const file = path.join(__dirname, "..", "tasks", "analysis", "candle-today.json");
    if (!fs.existsSync(file)) {
      return { available: false, why: "not generated yet — run node tasks/candle_probability.cjs" };
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const ms = Date.parse(raw.generatedAt);
    return {
      available: true,
      generatedAt: raw.generatedAt || null,
      ageHours: Number.isFinite(ms) ? Math.round(((Date.now() - ms) / 3600000) * 10) / 10 : null,
      note: raw.note || null,
      reads: Array.isArray(raw.reads) ? raw.reads : [],
      actionable: Array.isArray(raw.reads) ? raw.reads.filter(r => r && r.actionable).length : 0,
      feedsTheGate: false,
    };
  } catch (e) {
    // Observability must never take the endpoint down — same rule as the shadow block.
    console.error(`[daily-plan] candle read unreadable (${e.message})`);
    return { available: false, why: `unreadable: ${e.message}` };
  }
}

app.get("/api/daily-plan", (_, res) => {
  const plan = {
    date:     new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    // The number every confidence on this page is measured against. It was NOT in
    // this payload, so dashboard/daily-plan.html had no way to know it and coloured
    // confidence against a hardcoded 80/65 — while the live gate has been 70 since
    // 2026-08-02. That made a 72% signal, which is FIRING, render the same amber as a
    // 66% one that is five points short, on the one page read before trading.
    // Sent live rather than baked in, for the reason CLAUDE.md gives about this exact
    // number: anything that hardcodes it is correct only until the gate next moves.
    // settingsError travels with it because a non-null value means the gate shown is a
    // built-in DEFAULT, not the saved config — invisible in the number alone.
    gate:         strategySettings.confidenceThreshold,
    settingsError: strategySettingsError,
    signals: {
      btc:  signalCache.btc  ? { signal: signalCache.btc.signal,  confidence: signalCache.btc.confidence,  entry: signalCache.btc.entry,  stop: signalCache.btc.stop,  target: signalCache.btc.target,  setup: signalCache.btc.setup,  regime: signalCache.btc.regime,  rr: signalCache.btc.rr  } : null,
      gold: signalCache.gold ? { signal: signalCache.gold.signal, confidence: signalCache.gold.confidence, entry: signalCache.gold.entry, stop: signalCache.gold.stop, target: signalCache.gold.target, setup: signalCache.gold.setup, regime: signalCache.gold.regime, rr: signalCache.gold.rr } : null,
      spx:  signalCache.spx  ? { signal: signalCache.spx.signal,  confidence: signalCache.spx.confidence,  entry: signalCache.spx.entry,  stop: signalCache.spx.stop,  target: signalCache.spx.target,  setup: signalCache.spx.setup,  regime: signalCache.spx.regime,  rr: signalCache.spx.rr  } : null,
    },
    prices:   { btc: priceCache.btc, gold: priceCache.gold, spx: priceCache.spx, dxy: priceCache.dxy, vix: priceCache.vix },
    // Measured next-candle geometry, D1 and H4 per asset. Separate key, feedsTheGate
    // false, and most mornings every read says INSIDE NOISE — which is the honest
    // answer and is printed in those words rather than left as a bare percentage.
    candleRead: readCandleToday(),
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

// ── /api/calendar — the economic week, which was fetched and never shown ──
//
// 74 events are pulled from ForexFactory every run and appear on NONE of the eight
// dashboards. /api/newsfilter returns only a COUNT, and /api/daily-plan buries today's
// high-impact rows inside a larger payload. For a system trading Gold and the dollar,
// "what is coming and when" is not decoration.
//
// Uses ev.country, which is the field the feed actually has. There is no `currency`
// field on any of the 74 events — a detail that matters far more than this endpoint,
// because isNewsBlackout() reads ev.currency and therefore never matches anything. That
// is REPORTED here as blackoutFieldBug rather than fixed silently: repairing it changes
// what trades, and that is not a reporting endpoint's decision to make.
app.get("/api/calendar", (_, res) => {
  try {
    const WATCHED = ["USD", "XAU"];
    const now = Date.now();

    const rows = newsCache.map(ev => {
      const at = Date.parse(ev.date);
      if (!Number.isFinite(at)) return null;      // a row with no readable time is not a plan
      const country = String(ev.country ?? "").toUpperCase();
      return {
        title: ev.title,
        country,
        impact: ev.impact || "Unknown",
        at: new Date(at).toISOString(),
        minutesFromNow: Math.round((at - now) / 60000),
        forecast: ev.forecast || null,
        previous: ev.previous || null,
        high: String(ev.impact || "").toLowerCase() === "high",
        watched: WATCHED.includes(country),
      };
    }).filter(Boolean).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    const highWatched = rows.filter(r => r.high && r.watched);
    res.json({
      total: rows.length,
      events: rows,
      next: rows.find(r => r.minutesFromNow >= 0 && r.high && r.watched) || null,
      highImpactWatched: highWatched.length,
      watchedCountries: WATCHED,
      newsFilterEnabled: features.newsFilter,
      // Stated plainly so nobody reads "newsFilter: true" as protection.
      // Repaired 2026-08-12: isNewsBlackout() read ev.currency, a field this feed does
      // not carry, so the blackout had never fired once. Kept as a field rather than
      // deleted so the panel states the CURRENT truth instead of silently dropping a
      // warning it used to show.
      blackoutFieldBug: null,
      blackoutRepairedAt: "2026-08-12",
      // What the repaired filter is actually watching, so the panel can say it.
      blackoutWindowMinutes: 30,
      feedsTheGate: false,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[calendar]", e.message);
    res.status(500).json({ error: e.message, events: [] });
  }
});

// News blackout status (used by MT5 bridge before placing orders)
app.get("/api/newsfilter", (_, res) => {
  const status = isNewsBlackout();
  // `watching` is the number this endpoint was missing.
  //
  // It reported enabled:true, blackout:false and events:74 for months while matching
  // NOTHING, because the filter read a field the feed does not carry. Every one of
  // those numbers was true and the conclusion drawn from them was false. A count of
  // events the filter can actually SEE makes that failure loud: watching:0 with a
  // non-zero events count is the signature of exactly that bug returning.
  const watching = newsCache.filter(ev => {
    if (!ev.impact || ev.impact.toLowerCase() !== "high") return false;
    const market = String(ev.country ?? ev.currency ?? "").toUpperCase();
    return market === "USD" || market === "XAU";
  }).length;
  res.json({
    enabled: features.newsFilter, ...status,
    events: newsCache.length,
    watching,
    windowMinutes: 30,
    healthy: newsCache.length === 0 || watching > 0,
  });
});

// ══════════════════════════════════════════════════════════════
//  SCHEDULED JOBS
// ══════════════════════════════════════════════════════════════

// 6:45 AM — refresh signals + run full morning plan
cron.schedule("45 6 * * *", async () => {
  await fetchPrices();
  await queueSignalRefresh();
  await fetchCongress();
  await fetchFlow();
  generateDailyPlan();
  console.log("[cron] 6:45 AM — plan ready");
  // Run Python daily plan generator in background
  const { execFile } = require("child_process");
  // Probed, not taken from PATH — see server/python_path.js.
  const PYTHON_BIN = require("./python_path").pythonBinOrDefault();
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
  await queueSignalRefresh();
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
  // Probed, not taken from PATH — see server/python_path.js.
  const PYTHON = require("./python_path").pythonBinOrDefault();
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

  // Find worst setup.
  //
  // NON_SETUP_NAMES excluded, and here it matters more than anywhere else this guard
  // appears: this cron does not merely REPORT the worst bucket, it writes a proposal
  // recommending "tighten entry criteria or disable" and reads getLearningBoost() for
  // it. Without the guard a run of WAIT-named fills could be nominated as the worst
  // "setup", producing a proposal to disable the ABSENCE of a setup — a recommendation
  // a human might reasonably act on.
  //
  // Nothing is dropped: the skipped rows are counted and travel with the proposal, so
  // the reader can see that some closed trades were not attributable rather than
  // wondering why the totals do not add up.
  const bySetup = {};
  let unattributedClosed = 0;
  for (const t of closed) {
    if (!t.setup || NON_SETUP_NAMES.has(String(t.setup).trim().toUpperCase())) {
      unattributedClosed++;
      continue;
    }
    const s = t.setup;
    if (!bySetup[s]) bySetup[s] = { wins: 0, losses: 0 };
    if (t.pnl > 0) bySetup[s].wins++; else bySetup[s].losses++;
  }
  if (unattributedClosed) {
    console.warn(`[agent] ${unattributedClosed} closed trade(s) carry no real setup name and were ` +
      `excluded from the worst-setup search. Their P&L is still in the journal.`);
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
    // Carried so the reader can reconcile the totals rather than wonder why closed
    // trades outnumber the ones behind this verdict.
    closedConsidered: closed.length - unattributedClosed,
    closedTotal: closed.length,
    unattributedClosed,
    recommendation: `${worstSetup} has ${(worstWR * 100).toFixed(1)}% WR — review and tighten entry criteria or disable. Learning engine has already applied ${getLearningBoost(worstSetup)} confidence adjustment.`
      + (unattributedClosed ? ` (${unattributedClosed} closed trade(s) carry no real setup name and were not considered.)` : "")
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
Never loosen or suggest bypassing the live confidence gate or the daily-loss circuit breaker just because nothing is firing — a quiet market is a correct read, not a bug. Never state the gate as a number from memory: this prompt is built once at startup, so any figure baked in here goes stale the moment the setting moves. It said "the 65% confidence gate" for weeks after the gate became 70. Read it from /api/strategy-settings and check settingsError before quoting it.
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
          // loadProposals now THROWS on a corrupt file rather than reporting an empty
          // list, so this reports the fault instead of "No proposals on record." — a
          // reassuring sentence that used to mean the opposite of what it said.
          try {
            const { proposals } = loadProposals();
            if (!proposals.length) resultText = "No proposals on record.";
            else resultText = proposals.slice(0, 10).map(p =>
              `[${p.status}] ${p.id} — ${p.summary}${p.prUrl ? ` (${p.prUrl})` : ""} (${p.createdAt})`
            ).join("\n");
          } catch (e) { resultText = "Proposals file is unreadable, not empty: " + e.message; }
        } else if (block.name === "approve_proposal") {
          const { id } = block.input || {};
          // Wrapped because this one WRITES. If loadProposals throws on a corrupt file
          // the save must not run at all — that is the whole point of it throwing —
          // and the chat should say so rather than surfacing a raw stack.
          try {
            const data = loadProposals();
            const prop = data.proposals.find(p => p.id === id);
            if (!prop) resultText = `No proposal found with id ${id}.`;
            else {
              prop.status = "approved";
              prop.approvedAt = new Date().toISOString();
              saveProposals(data);
              resultText = `Approved: ${prop.summary}. Marked ready to deploy next session — this did not deploy it live.`;
            }
          } catch (e) { resultText = "Could not approve — the proposals file is unreadable: " + e.message; }
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
    // ev.COUNTRY, not ev.currency.
    //
    // This filter read ev.currency, which does not exist on this feed: 0 of 74 events
    // carry it and all 74 carry ev.country. `relevant` was therefore always empty and
    // the blackout NEVER FIRED — not once in this system's life — while
    // /api/newsfilter reported enabled:true and the bridge treated that as protection.
    // Found 2026-08-12, a day with four high-impact USD CPI prints at 12:30 UTC that it
    // was completely blind to.
    //
    // Both fields are read so a feed that renames it back cannot silently re-break
    // this. XAU is kept in the watch list but never matches: the feed's country codes
    // are AUD CAD CHF CNY EUR GBP JPY NZD USD, with no metals. USD is what actually
    // moves XAUUSD, so USD coverage is the point.
    const market = String(ev.country ?? ev.currency ?? "").toUpperCase();
    return market === "USD" || market === "XAU";
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
// Health of the AI trade filter.
//
// The filter deliberately FAILS OPEN: a network blip or an expired key must not
// freeze trading. The cost of that choice is that a permanently broken filter is
// indistinguishable from a working one — every trade is approved either way, and
// the only trace is one line in server_log.txt. Confirmed 2026-08-03 with the API
// credit exhausted: every call returned {approved:true, "AI error — proceeding"}
// while the healer still reported green.
//
// This is the same shape as the bug where checkMt5Bridge reported "1/1 accounts"
// while half the system was dead: a safety layer that is absent and invisible.
// Fail open, but say so.
let aiFilterHealth = {
  lastOkAt: null,
  lastFailAt: null,
  lastError: null,
  consecutiveFailures: 0,
  totalCalls: 0,
};

// Used only when strategy_settings.json cannot be read. Matches the shipped default
// for confidenceThreshold, so a settings failure degrades to the documented gate
// rather than to no gate at all.
const AI_FILTER_FALLBACK_CONFIDENCE = 70;

// ── AI filter: subscription fallback ─────────────────────────────────────────
//
// WHY THIS EXISTS. This server is the ONLY component billed to the pay-as-you-go
// API. Everything else — the morning agent, the weekly review, every scheduled
// job — runs through the `claude` CLI on the claude.ai subscription, because
// morning_agent.bat learned this lesson on 2026-08-03 and clears
// ANTHROPIC_API_KEY before every call. Measured on one box on 2026-08-19, seconds
// apart: the CLI answered OK while the API key returned 400 "credit balance too
// low". So a working account had a dead trade filter purely because this one path
// used a different billing rail.
//
// The filter fails OPEN, so the cost of that was silent: every trade auto-approved
// with no review and nothing on a screen saying so.
//
// STDIN, NOT ARGV. The prompt is written to the child's stdin and the argv stays a
// fixed five tokens. Passing it as an argument would put a multi-hundred-character
// string containing quotes, braces and newlines through cmd.exe, which is exactly
// how .bat files in this repo lost everything after the word `claude`.
//
// Timeout is 20s against the bridge's 25s abandon, so a slow call still leaves the
// bridge to make its own decision rather than both sides timing out. Measured
// median is 5.0s over three runs.
const AI_FILTER_CLI_TIMEOUT_MS = 20000;
// Kill switch. Set AI_FILTER_CLI_FALLBACK=0 to disable without a code change; any
// other value (or unset) leaves it on.
const AI_FILTER_CLI_ENABLED = process.env.AI_FILTER_CLI_FALLBACK !== "0";

// Raw text from the CLI, or null if that rail is unavailable too. Shared by the
// trade filter and by the client-level fallback that covers the other nine call
// sites — see wrapAnthropicWithCliFallback.
function runClaudeCli(prompt, timeoutMs) {
  return new Promise((resolve) => {
    if (!AI_FILTER_CLI_ENABLED || process.platform !== "win32") return resolve(null);

    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    let child;
    try {
      child = require("child_process").spawn(
        process.env.COMSPEC || "cmd.exe",
        ["/c", "claude", "-p", "--output-format", "text"],
        {
          windowsHide: true,
          env: { ...process.env, ANTHROPIC_API_KEY: "" },
        }
      );
    } catch (e) { return finish(null); }

    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(null); },
      timeoutMs || AI_FILTER_CLI_TIMEOUT_MS);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", () => {
      clearTimeout(timer);
      const text = stdout.trim();
      finish(text.length ? text : null);
    });

    try { child.stdin.write(prompt); child.stdin.end(); }
    catch (e) { clearTimeout(timer); finish(null); }
  });
}

// Background work (weekly report, commentary, ai-brain) is not on the trade path and
// can afford a longer ceiling than the filter's 20s.
const CLAUDE_CLI_GENERAL_TIMEOUT_MS = 90000;

/**
 * Put the WHOLE client on the working rail, not just the trade filter.
 *
 * There are TEN anthropic.messages.create call sites in this file — the filter,
 * askClaude (/api/chat), generateTradeCommentary, reviewOpenPositions,
 * generateWeeklyReport, /api/backtest, /api/ai-brain, /api/engineer/architect and two
 * analysis paths. Fixing only the filter left nine of them dead on a key the API
 * rejects, which is exactly why today's SP500 fill carries no commentary and the log
 * repeats "[review] Error: 400".
 *
 * Every one of them is a PLAIN TEXT call — no tools, no streaming, verified by
 * inspection — so a single wrapper on messages.create covers all ten without touching
 * a single call site. Wrapping the client rather than editing ten places also means a
 * future call site inherits the fallback automatically instead of quietly not having it.
 *
 * If the CLI is unavailable too it rethrows the ORIGINAL error, so every existing
 * catch block behaves exactly as it does today.
 */
function wrapAnthropicWithCliFallback(client) {
  if (!client || !client.messages || typeof client.messages.create !== "function") return client;
  const realCreate = client.messages.create.bind(client.messages);

  client.messages.create = async (params) => {
    try {
      return await realCreate(params);
    } catch (apiError) {
      // Flatten to the prompt the CLI needs. Content can be a string or the block
      // array form; both appear in this file.
      const parts = [];
      if (params && typeof params.system === "string") parts.push(params.system);
      for (const message of (params && params.messages) || []) {
        const content = message && message.content;
        if (typeof content === "string") parts.push(content);
        else if (Array.isArray(content)) {
          for (const block of content) if (block && typeof block.text === "string") parts.push(block.text);
        }
      }
      const prompt = parts.join("\n\n").trim();
      if (!prompt) throw apiError;

      const text = await runClaudeCli(prompt, CLAUDE_CLI_GENERAL_TIMEOUT_MS);
      if (text === null) throw apiError;

      console.log(`[anthropic] API rail failed (${String(apiError.message || apiError).slice(0, 80)}) — served via CLI/subscription`);
      // Same shape every caller already destructures: content[].type === "text".
      return { content: [{ type: "text", text }], stop_reason: "end_turn", _viaCli: true };
    }
  };
  return client;
}

function runAiFilterViaCli(prompt) {
  return new Promise((resolve) => {
    if (!AI_FILTER_CLI_ENABLED || process.platform !== "win32") return resolve(null);

    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    let child;
    try {
      child = require("child_process").spawn(
        process.env.COMSPEC || "cmd.exe",
        ["/c", "claude", "-p", "--output-format", "text"],
        {
          windowsHide: true,
          // Emptied, not deleted: the CLI treats a set key as "use the API" and
          // would bill the same dead rail this exists to route around.
          env: { ...process.env, ANTHROPIC_API_KEY: "" },
        }
      );
    } catch (e) { return finish(null); }

    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(null); }, AI_FILTER_CLI_TIMEOUT_MS);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", () => {
      clearTimeout(timer);
      // Same extraction as the SDK path: take the first JSON object in the reply,
      // because the CLI can prepend or append prose no matter how the prompt asks.
      const match = stdout.match(/\{[\s\S]*?\}/);
      if (!match) return finish(null);
      try { finish(JSON.parse(match[0])); } catch (e) { finish(null); }
    });

    try { child.stdin.write(prompt); child.stdin.end(); }
    catch (e) { clearTimeout(timer); finish(null); }
  });
}

app.post("/api/claude-approve-trade", async (req, res) => {
  const { signal, symbol, entry, stop, target } = req.body ?? {};
  if (!anthropic || !signal) {
    if (!anthropic) {
      aiFilterHealth.totalCalls++;
      aiFilterHealth.consecutiveFailures++;
      aiFilterHealth.lastFailAt = new Date().toISOString();
      aiFilterHealth.lastError = "no Anthropic client configured (missing API key)";
    }
    return res.json({ approved: true, reason: "No AI available — proceeding", risk: "UNKNOWN" });
  }
  aiFilterHealth.totalCalls++;

  const rr = (entry && stop && target)
    ? (Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(1)
    : "N/A";
  const newsCheck = isNewsBlackout();
  const macro = `DXY ${priceCache.dxy ?? "N/A"} | VIX ${priceCache.vix ?? "N/A"}`;

  // The confidence bar below used to be a hardcoded 60, which made this prompt a
  // THIRD invisible copy of the gate - after strategySettings.confidenceThreshold
  // and sizing.js's MIN_CONFIDENCE = 65. The bridge calls this endpoint before every
  // execution and treats a rejection as final, so the EFFECTIVE live gate was
  // max(confidenceThreshold, 60) no matter what the dashboard said.
  //
  // That mattered the moment d320785 removed the sizing.js clamp: confidenceThreshold
  // = 50 finally became real, and this 60 stepped straight into the vacancy. Measured
  // 2026-08-06 - BTC at confidence 50 was approved by the engine and vetoed here every
  // 15-30 minutes for a full day, on both machines, with the reason logged only to the
  // bridge log and nowhere a dashboard would show it.
  //
  // Falls back to the shipped default rather than 0 so a missing/unreadable settings
  // file cannot silently drop the AI filter's bar to "approve everything".
  const aiMinConfidence = Number.isFinite(Number(strategySettings?.confidenceThreshold))
    ? Number(strategySettings.confidenceThreshold)
    : AI_FILTER_FALLBACK_CONFIDENCE;

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
    `APPROVE the trade if ALL of: confidence >= ${aiMinConfidence}%, R/R >= 1.5, no news blackout, macro not strongly against.\n` +
    `REJECT if: confidence < ${aiMinConfidence}%, R/R < 1.5, news blackout active, strong macro headwind (strong DXY against Gold/BTC long), or VIX > 30 on a BUY.\n\n` +
    `Reply with ONLY valid JSON, no markdown:\n` +
    `{"approved": true, "reason": "one sentence max", "risk": "LOW"}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-opus-5",
      // Adaptive thinking, NOT { type: "enabled", budget_tokens: N }. The fixed
      // thinking-budget form is removed on claude-opus-5 and returns a 400 — depth
      // is controlled by output_config.effort instead. Because this endpoint fails
      // open, that 400 meant every trade was auto-approved with no AI review and
      // nothing surfaced it; found 2026-08-03 the moment the healer's new aiFilter
      // check started reporting the error text.
      //
      // effort "low" is deliberate: this is a short, scoped verdict on a prompt
      // that already contains every number, and the bridge abandons the call after
      // 25s. max_tokens has to cover thinking AND the reply, hence the headroom
      // over the ~50 tokens of JSON actually wanted.
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }]
    });
    const text = (msg.content ?? []).find(b => b.type === "text")?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    const approved = parsed?.approved ?? true;
    const reason   = parsed?.reason   ?? "No reason given";
    const risk     = parsed?.risk     ?? "MEDIUM";
    aiFilterHealth.lastOkAt = new Date().toISOString();
    aiFilterHealth.consecutiveFailures = 0;
    aiFilterHealth.lastError = null;
    console.log(`[AI-filter] ${symbol} ${signal.signal}: ${approved ? "APPROVED" : "REJECTED"} — ${reason}`);
    res.json({ approved, reason, risk });
  } catch (e) {
    // The API rail failed. Before giving up and auto-approving, try the rail that
    // every other component in this system already uses.
    const viaCli = await runAiFilterViaCli(prompt);
    if (viaCli && typeof viaCli.approved === "boolean") {
      // A review DID happen, so the health counters record success — the filter is
      // working, it simply reached Anthropic another way. Reporting this as a
      // failure would leave a permanent red on a system that is functioning.
      aiFilterHealth.lastOkAt = new Date().toISOString();
      aiFilterHealth.consecutiveFailures = 0;
      aiFilterHealth.lastError = null;
      const reason = viaCli.reason ?? "No reason given";
      console.log(`[AI-filter] ${symbol} ${signal.signal}: ${viaCli.approved ? "APPROVED" : "REJECTED"} (via CLI/subscription) — ${reason}`);
      return res.json({ approved: viaCli.approved, reason, risk: viaCli.risk ?? "MEDIUM" });
    }

    // Both rails are down. Unchanged behaviour: fail OPEN. Blocking trades because
    // a billing problem cannot be reached would spend the scarce thing — samples —
    // to protect nothing.
    aiFilterHealth.lastFailAt = new Date().toISOString();
    aiFilterHealth.consecutiveFailures++;
    aiFilterHealth.lastError = String(e.message || e).slice(0, 200);
    console.error("[AI-filter] Error:", e.message, "— CLI fallback also unavailable");
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
app.get("/strategy",   (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "strategy.html")));
app.get("/report",     (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "report.html")));
// Reading surface only. It composes /api/fleet, /api/gate-health, /api/signals,
// /api/risk-status and /api/mt5/health — it runs nothing and posts nothing.
app.get("/architecture", (_, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "architecture.html")));
app.use("/screenshots", express.static(path.join(__dirname, "..", "dashboard", "screenshots")));
app.use(express.static(path.join(__dirname, "..", "commercial")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "..", "commercial", "index.html")));
// Public. Reads only /api/signals, /api/strategy-settings and /api/evidence-board,
// all of which already answer 200 unauthenticated. Deliberately NOT /api/risk-status,
// which returns the MT5 login in its account config.
app.get("/investment", (_, res) => res.sendFile(path.join(__dirname, "..", "commercial", "investment.html")));

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
// Task-name prefixes used by this system's own scheduled jobs. "SmartEntry" was the
// only one until 2026-08-16, and that single word silently hid "JARVIS Morning Agent"
// from BOTH lists in the AI-employee ledger: it could not be linked to its declared
// job, and it could not even appear in the unappraised list, because it never survived
// this filter to reach either. A daily Claude job, running clean for weeks, that
// nothing on any surface could see. Widening admits exactly one more task on this box
// and excludes nothing that matched before.
const SCHEDULED_TASK_PREFIXES = ["SmartEntry", "JARVIS"];
const isOwnScheduledTask = (name) =>
  SCHEDULED_TASK_PREFIXES.some((prefix) => name.startsWith(prefix));
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
        if (!isOwnScheduledTask(name)) return acc;
        acc.push({ name, nextRun: cells[1], status: cells[2] });
        return acc;
      }, []);
      finish({ available: true, tasks });
    });
  });
}

// Both boxes, because the archive lands in a different place on each. vps_backup.ps1
// writes C:\ai-trading-dashboard-backups on the VPS; pull_vps_backup.bat copies the
// newest one down to <repo>\vps-backups on the laptop. Checking only the first path
// made this read MISSING forever on the laptop — a permanently red row is one you
// stop reading, which is the exact failure this page exists to avoid.
const BACKUP_DIRS = [
  path.join(__dirname, "..", "vps-backups"),
  "C:\\ai-trading-dashboard-backups",
];

// Verbose task query — the non-verbose one above returns name, next run and status
// only, which cannot answer "did it succeed" or "what does it actually run". Both
// of those are what let the AI-employee ledger match a job to its task across two
// machines that name the same job differently.
//
// Slower than the plain query (it returns every column for every task), so it gets
// its own cache. Windows-only, like the query above; anything else reports null and
// the ledger falls back to reading log files alone.
// The verbose query returns EVERY column for every task — 326 lines and 150KB on the
// VPS, measured at 7.3s there against a shared 8s budget it kept losing by a whisker.
// It gets its own, larger timeout and a long cache: scheduled-task results change on
// the order of hours, so paying this once every five minutes is right.
const VERBOSE_TASK_TIMEOUT_MS = 25 * 1000;
const VERBOSE_TASK_CACHE_MS   = 5 * 60 * 1000;
let verboseTaskCache = { at: 0, value: null };

function readScheduledTasksVerbose() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(null);
    if (verboseTaskCache.value && Date.now() - verboseTaskCache.at < VERBOSE_TASK_CACHE_MS) {
      return resolve(verboseTaskCache.value);
    }

    const child = require("child_process").spawn("schtasks", ["/query", "/fo", "csv", "/v"], { windowsHide: true });
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (value) verboseTaskCache = { at: Date.now(), value };
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(null); }, VERBOSE_TASK_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const rows = stdout.split(/\r?\n/)
          .map(line => line.split('","').map(cell => cell.replace(/^"|"$/g, "").trim()))
          .filter(cells => cells.length > 3);
        // Keep the header rather than using /nh: column ORDER is not contractual
        // across Windows builds, and reading by index without a header is how a
        // parser silently starts reporting the wrong field.
        const header = rows.find(cells => cells.includes("TaskName"));
        if (!header) return finish(null);
        const col = (name) => header.indexOf(name);
        const idxName = col("TaskName"), idxStatus = col("Status"), idxNext = col("Next Run Time");
        const idxLastRun = col("Last Run Time"), idxResult = col("Last Result"), idxRuns = col("Task To Run");
        if (idxName === -1) return finish(null);

        // One ROW PER TRIGGER, not per task: "SmartEntry Ensure Running" has three
        // triggers and appeared three times in the first run of this. Keyed by name
        // so a multi-trigger task is one job, with the soonest next-run kept.
        const byName = new Map();
        for (const cells of rows) {
          if (cells === header || cells.includes("TaskName")) continue;
          const name = (cells[idxName] || "").replace(/^\\+/, "");
          if (!name || !isOwnScheduledTask(name)) continue;
          const rawResult = idxResult === -1 ? null : Number(cells[idxResult]);
          const task = {
            name,
            status:    idxStatus  === -1 ? null : cells[idxStatus],
            nextRun:   idxNext    === -1 ? null : cells[idxNext],
            lastRun:   idxLastRun === -1 ? null : cells[idxLastRun],
            lastResult: Number.isFinite(rawResult) ? rawResult : null,
            taskToRun: idxRuns    === -1 ? null : cells[idxRuns],
          };
          const existing = byName.get(name);
          if (!existing) { byName.set(name, task); continue; }
          // Same task, different trigger: the run history is identical, so keep the
          // earliest upcoming run as the one worth showing.
          const a = Date.parse(existing.nextRun || ""), b = Date.parse(task.nextRun || "");
          if (Number.isFinite(b) && (!Number.isFinite(a) || b < a)) existing.nextRun = task.nextRun;
        }
        finish([...byName.values()]);
      } catch (e) {
        console.error("[tasks] verbose query parse failed:", e.message);
        finish(null);
      }
    });
  });
}

function readLatestBackup() {
  const found = [];
  for (const backupDir of BACKUP_DIRS) {
    try {
      if (!fs.existsSync(backupDir)) continue;
      for (const name of fs.readdirSync(backupDir)) {
        if (!name.toLowerCase().endsWith(".zip")) continue;
        try {
          const stat = fs.statSync(path.join(backupDir, name));
          found.push({ name, sizeKB: Math.round(stat.size / 1024), modified: stat.mtime.toISOString(), dir: backupDir });
        } catch (_) { /* a file that vanished mid-scan is not a missing backup */ }
      }
    } catch (_) { /* unreadable directory — try the next one */ }
  }
  if (found.length === 0) return null;
  return found.sort((a, b) => new Date(b.modified) - new Date(a.modified))[0];
}

// ── Fleet view: pull what the OTHER box actually believes ─────────────────────
//
// /api/peer-heartbeat already answers "is the other box alive", but liveness has
// never been the expensive failure. Every expensive failure has been a DIVERGENCE
// while both boxes looked healthy: AutoTrading disabled on the VPS for 11 days
// behind green health checks; strategy_settings.json never syncing, so the same
// commit ran a different gate; cohort_table.js absent, so the box that trades
// continuously was the one box that never reported a dead cohort. This pulls the
// peer's own public state and compares it, so a split shows up on a screen instead
// of in the journal weeks later.
//
// Read-only and out of band: three GETs against endpoints that are already public,
// writing nothing and feeding no gate. With PEER_SERVER_URL unset it reports
// configured:false and this endpoint behaves exactly as it did before.
const PEER_PROBE_TIMEOUT_MS = 3000;
const PEER_PROBE_CACHE_MS   = 30 * 1000;
const BACKUP_STALE_HOURS    = 24;
const LOG_DIR_WARN_MB       = 500;
const PARITY_STALE_DAYS     = 7;
// tasks/vps_monitor.ps1 pushes every 5 minutes, so three missed pushes is a real
// silence rather than one unlucky timeout.
const HEARTBEAT_STALE_MINUTES = 15;

/**
 * Boxes that MUST check in, declared rather than discovered — you cannot notice
 * the absence of something you never declared, which is the same reasoning that
 * put MT5_EXPECTED_ACCOUNTS in keys.env. peerHeartbeats is in-memory, so an
 * undeclared box that has simply never pushed is indistinguishable from one that
 * died; declaring it is what makes the silence mean something.
 *
 * Unset (the laptop, which nothing can push to) => no alarm, a standing note.
 */
function expectedHeartbeatBoxes() {
  return String(process.env.PEER_HEARTBEAT_EXPECT || "")
    .split(",").map(name => name.trim()).filter(Boolean);
}

function assessHeartbeats(uptimeSeconds) {
  const now = Date.now();
  const expected = expectedHeartbeatBoxes();
  const seen = Object.values(peerHeartbeats).map(beat => {
    const ageSeconds = Math.round((now - new Date(beat.at).getTime()) / 1000);
    return { ...beat, ageSeconds, stale: ageSeconds > HEARTBEAT_STALE_MINUTES * 60 };
  });
  const byName = new Map(seen.map(beat => [beat.box.toUpperCase(), beat]));

  // A restart empties the in-memory store, so nothing is "missing" until a full
  // stale window has passed since boot — otherwise every restart invents an alarm.
  const withinStartupGrace = uptimeSeconds < HEARTBEAT_STALE_MINUTES * 60;

  const missing = [], stale = [];
  for (const name of expected) {
    const beat = byName.get(name.toUpperCase());
    if (!beat) { if (!withinStartupGrace) missing.push(name); }
    else if (beat.stale) stale.push(name);
  }
  return { expected, seen, missing, stale, withinStartupGrace, staleAfterMinutes: HEARTBEAT_STALE_MINUTES };
}

// vps_monitor.ps1 pushes every 5 minutes; checking on the same cadence detects a
// silence within one stale window rather than whenever somebody next opens a page.
const PEER_SILENCE_CHECK_MS = 5 * 60 * 1000;

/**
 * Box names currently reported as silent. The alert is EDGE-triggered off this set,
 * not off a cooldown timer: a cooldown re-sends forever during a long outage and
 * trains you to mute the channel, which is the same failure as never alerting.
 */
const peerSilenceAlerted = new Set();

/**
 * Where an unattended alert goes. TELEGRAM_CHAT_ID is the only reliable source on the
 * VPS: knownChatIds is populated by polling, and polling is permanently disabled there
 * because a webhook is registered and getUpdates 409s on every call.
 */
function peerAlertChatId() {
  return TELEGRAM_CHAT_ID || [...knownChatIds][0] || "";
}

/**
 * sendTelegram posts with parse_mode HTML, so any raw < or & in an interpolated value
 * makes Telegram reject the whole message with a 400 — which sendTelegram catches and
 * logs, silently dropping the alert. An alert that cannot render is an alert that does
 * not arrive, which is the failure this whole watcher exists to remove.
 */
function escapeTelegramHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The peer's last known state, so the alert says what it was doing when it went quiet. */
function describeLastKnownState(state) {
  if (!state) return "last state: not reported";
  const parts = [];
  if (state.gate !== null)         parts.push(`gate ${state.gate}`);
  if (state.halted)                parts.push(`HALTED${state.haltReason ? ` (${escapeTelegramHtml(state.haltReason)})` : ""}`);
  if (state.armed?.length)         parts.push(`armed ${escapeTelegramHtml(state.armed.join(","))}`);
  if (state.bridgesSilent?.length) parts.push(`bridges silent ${escapeTelegramHtml(state.bridgesSilent.join(","))}`);
  if (state.settingsError)         parts.push("settings ERROR");
  return parts.length ? `last state: ${parts.join(" · ")}` : "last state: reported, nothing notable";
}

function silenceAlertText(name, beat, staleAfterMinutes) {
  const header = `🔴 <b>FLEET: ${escapeTelegramHtml(name)} HAS GONE SILENT</b>`;
  if (!beat) {
    return `${header}\n\nDeclared in PEER_HEARTBEAT_EXPECT but has not checked in once since this server started.\n\nThat box cannot be reached from here, so its silence is the only symptom available — and a sleeping machine's bridge stops trading with nothing else looking wrong.`;
  }
  const minutes = Math.round(beat.ageSeconds / 60);
  const forHuman = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return `${header}\n\nNo check-in for <b>${forHuman}</b> (alarm threshold ${staleAfterMinutes}m).\nLast seen: ${beat.at}\n${describeLastKnownState(beat.state)}\n\nThat box cannot be reached from here, so its silence is the only symptom available.`;
}

function recoveryAlertText(name, beat) {
  const detail = beat ? `\n${describeLastKnownState(beat.state)}` : "";
  return `🟢 <b>FLEET: ${escapeTelegramHtml(name)} IS BACK</b>\n\nCheck-ins have resumed.${detail}`;
}

/**
 * Evaluate peer silence on a timer and alert on the transition.
 *
 * This exists because assessHeartbeats() had exactly one caller — the /api/system-plan
 * handler — so the detector only ran when a human was already looking. On 2026-08-21
 * that let a 33.4-hour laptop outage pass with no notification of any kind: nine
 * scheduled jobs missed a full day and the gap was found by reading a log afterwards.
 *
 * Read-only over state the heartbeat endpoint already records. Sends a message and
 * nothing else: no gate, no signal, no position, no setting.
 */
function checkPeerSilence() {
  try {
    const heartbeats = assessHeartbeats(Math.round(process.uptime()));
    if (!heartbeats.expected.length) return;

    const byName  = new Map(heartbeats.seen.map(beat => [beat.box.toUpperCase(), beat]));
    const chatId  = peerAlertChatId();
    const downNow = new Set([...heartbeats.missing, ...heartbeats.stale]);

    for (const name of downNow) {
      if (peerSilenceAlerted.has(name)) continue;
      peerSilenceAlerted.add(name);
      const beat = byName.get(name.toUpperCase()) || null;
      const text = silenceAlertText(name, beat, heartbeats.staleAfterMinutes);
      console.error(`[fleet] PEER SILENT: ${name} — ${beat ? `${beat.ageSeconds}s since last check-in` : "never checked in"}`);
      // Marked alerted BEFORE the send so a Telegram outage cannot turn one alert into
      // a retry every five minutes. A dropped alert is still visible in this log.
      if (chatId) sendTelegram(chatId, text).catch(() => {});
    }

    for (const name of [...peerSilenceAlerted]) {
      if (downNow.has(name)) continue;
      peerSilenceAlerted.delete(name);
      console.log(`[fleet] PEER RECOVERED: ${name}`);
      if (chatId) sendTelegram(chatId, recoveryAlertText(name, byName.get(name.toUpperCase()) || null)).catch(() => {});
    }
  } catch (e) {
    // A watcher that throws must not take the trading server with it.
    console.error("[fleet] peer-silence check failed:", e?.message || e);
  }
}

/**
 * Say at boot whether this box will ever actually alert. A watcher that cannot send is
 * indistinguishable from a healthy fleet, which is the exact class of decoration this
 * change exists to remove.
 */
function startPeerSilenceWatch() {
  const expected = expectedHeartbeatBoxes();
  if (!expected.length) {
    console.log("[fleet] Peer-silence watch INERT — PEER_HEARTBEAT_EXPECT unset (correct on a box nothing pushes to).");
    return;
  }
  if (!TELEGRAM_TOKEN || !peerAlertChatId()) {
    console.error(`[fleet] Peer-silence watch WATCHING ${expected.join(",")} BUT CANNOT ALERT — ${!TELEGRAM_TOKEN ? "TELEGRAM_TOKEN" : "TELEGRAM_CHAT_ID"} is unset. Silence will reach the log only.`);
  } else {
    console.log(`[fleet] Peer-silence watch armed — ${expected.join(",")}, alarm at ${HEARTBEAT_STALE_MINUTES}m, checking every ${PEER_SILENCE_CHECK_MS / 60000}m.`);
  }
  setInterval(checkPeerSilence, PEER_SILENCE_CHECK_MS).unref?.();
  checkPeerSilence();
}

/**
 * The worst MT5 bar staleness in ONE box's /api/signals payload.
 *
 * Per-asset barFreshness has been stamped on /api/signals since the wedged-terminal
 * check landed, and dashboard/index.html shows it — for this box only. The failure it
 * exists to catch is the one that hides best across the fleet: the bridge keeps
 * posting on schedule, receivedAt stays seconds old, the bars stop moving, and every
 * health check on both boxes stays green. The box that trades continuously is the one
 * nobody is looking at, so the fact has to travel.
 *
 * Only assets that actually reported checked:true are judged. A pre-timestamp bridge
 * sends no bar times, and counting that as fresh — or inventing an age or a date for
 * it — would turn an admitted gap into a confident wrong number.
 *
 * Which assets were judged and which were not travels with the verdict, and so does
 * each unjudged asset's OWN reason. A summary that reported checked:true while two of
 * three assets were never looked at would read as a clean pass, and a page that names
 * one hardcoded cause for "unverified" would prescribe the wrong remedy: no bars
 * pushed yet, a bridge that predates the timestamps, an empty cache after a restart
 * and a peer whose server predates this field are four different problems.
 *
 * judgedAt is the payload's own updatedAt, because every field here is FROZEN at
 * signal-refresh time. If the refresh chain stalls, "current" would otherwise stay on
 * screen forever — the same green-while-wedged pattern this check exists to break.
 *
 * `stale` stays a statement about the MT5 SERIES alone: when it is true the engine has
 * already fallen back to Yahoo, so the prices being served are current and it is the
 * broker feed that is not. `usedForThisSignal` carries that second fact.
 */
function summarizeBarFreshness(signalsPayload) {
  const nothingJudged = (reason, judgedAt = null, unjudgedAssets = []) => ({
    checked: false, staleAssets: [], worst: null,
    judgedAssets: [], unjudgedAssets, reason, judgedAt,
  });
  if (!signalsPayload || typeof signalsPayload !== "object") {
    return nothingJudged("the signals payload was not readable");
  }

  const judgedAt = typeof signalsPayload.updatedAt === "string" ? signalsPayload.updatedAt : null;

  // Discovered from the payload rather than from a hardcoded asset list: an asset
  // added to the engine and forgotten here would silently never be judged.
  const judged = [];
  const unjudged = [];
  for (const assetKey of Object.keys(signalsPayload)) {
    if (assetKey === "updatedAt") continue;
    const asset = signalsPayload[assetKey];
    if (asset === null) {
      unjudged.push({ asset: assetKey, reason: "no signal has been generated yet" });
      continue;
    }
    if (typeof asset !== "object") continue;   // a scalar field, not an asset
    const freshness = asset.barFreshness;
    if (!freshness || typeof freshness !== "object") {
      unjudged.push({ asset: assetKey, reason: "signal carries no barFreshness field — that server predates this check" });
      continue;
    }
    if (freshness.checked !== true) {
      unjudged.push({
        asset: assetKey,
        reason: typeof freshness.reason === "string" && freshness.reason
          ? freshness.reason
          : "reported unverified without a reason",
      });
      continue;
    }
    judged.push({
      asset: assetKey,
      stale: freshness.stale === true,
      ageMs: Number.isFinite(freshness.ageMs) ? freshness.ageMs : null,
      lastBarAt: typeof freshness.lastBarAt === "string" ? freshness.lastBarAt : null,
      reason: typeof freshness.reason === "string" ? freshness.reason : "",
      usedForThisSignal: freshness.usedForThisSignal === true,
    });
  }

  // Distinct reasons, so three assets failing for one cause read as one sentence.
  const unjudgedReason = [...new Set(unjudged.map(entry => entry.reason))].join("; ");
  if (judged.length === 0) {
    return nothingJudged(
      unjudged.length === 0 ? "no assets in the signals payload" : unjudgedReason,
      judgedAt,
      unjudged.map(entry => entry.asset),
    );
  }

  // Stale first, then the laggiest series. An absent age must lose every comparison
  // rather than win one by being falsy, and a broker-clock bar timed in the FUTURE
  // gives a negative age — which is still a real reading and must outrank "no age".
  const ageRank = (entry) => (entry.ageMs === null ? Number.NEGATIVE_INFINITY : entry.ageMs);
  judged.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? -1 : 1;
    return ageRank(b) - ageRank(a);
  });

  return {
    checked: true,
    staleAssets: judged.filter(entry => entry.stale).map(entry => entry.asset),
    worst: judged[0],
    judgedAssets: judged.map(entry => entry.asset),
    unjudgedAssets: unjudged.map(entry => entry.asset),
    reason: unjudgedReason,
    judgedAt,
  };
}

let peerProbeCache = { at: 0, value: null };

async function probePeer() {
  const base = String(process.env.PEER_SERVER_URL || "").trim().replace(/\/+$/, "");
  if (!base) return { configured: false, reachable: false, url: null, error: null };
  if (peerProbeCache.value && Date.now() - peerProbeCache.at < PEER_PROBE_CACHE_MS) {
    return peerProbeCache.value;
  }

  const getJson = (route) => axios
    .get(base + route, { timeout: PEER_PROBE_TIMEOUT_MS, validateStatus: (status) => status === 200 })
    .then((response) => response.data);

  const peer = {
    configured: true, url: base, reachable: false, probedAt: new Date().toISOString(), error: null,
    healthy: null, checks: null,
    gate: null, fixedLotSize: null, settingsError: null,
    halted: null, haltReason: "", dailyPnl: null, consecutiveLosses: null,
    accountTags: [], accounts: {}, bridges: { reporting: [], silent: [] },
    settings: null, aiWork: null,
    // Unverified until the peer answers, and unverified is NOT fresh. Replaced below
    // on both paths — fulfilled and rejected — so the shape never varies.
    barFreshness: {
      checked: false, staleAssets: [], worst: null,
      judgedAssets: [], unjudgedAssets: [], judgedAt: null,
      reason: "the peer has not been probed yet",
    },
  };

  // allSettled, never all: a peer that answers three of four questions is far more
  // useful than a probe that throws away every answer because the fourth timed out.
  const [healerResult, riskResult, settingsResult, aiWorkResult, signalsResult] = await Promise.allSettled([
    getJson("/api/healer"),
    getJson("/api/risk-status"),
    getJson("/api/strategy-settings"),
    getJson("/api/ai-work"),
    getJson("/api/signals"),
  ]);

  if (healerResult.status === "fulfilled") {
    peer.reachable = true;
    peer.healthy = healerResult.value?.healthy === true;
    peer.checks  = healerResult.value?.checks ?? null;
  }
  if (riskResult.status === "fulfilled") {
    peer.reachable = true;
    const remoteRisk = riskResult.value || {};
    peer.halted            = remoteRisk.halted === true;
    peer.haltReason        = typeof remoteRisk.haltReason === "string" ? remoteRisk.haltReason : "";
    peer.dailyPnl          = typeof remoteRisk.dailyPnl === "number" ? remoteRisk.dailyPnl : null;
    peer.consecutiveLosses = typeof remoteRisk.consecutiveLosses === "number" ? remoteRisk.consecutiveLosses : null;
    peer.accountTags       = Object.keys(remoteRisk.accounts || {});
    // Kept whole: config.autoMode per account is the only honest answer to "is that
    // box actually arming trades", and it is reported by the bridge that enforces it.
    peer.accounts          = remoteRisk.accounts || {};
  }
  if (settingsResult.status === "fulfilled") {
    peer.reachable = true;
    const remoteSettings = settingsResult.value || {};
    peer.gate          = typeof remoteSettings.confidenceThreshold === "number" ? remoteSettings.confidenceThreshold : null;
    peer.fixedLotSize  = typeof remoteSettings.fixedLotSize === "number" ? remoteSettings.fixedLotSize : null;
    peer.settingsError = remoteSettings.settingsError || null;
    peer.settings      = remoteSettings;
  }
  if (aiWorkResult.status === "fulfilled") {
    peer.reachable = true;
    peer.aiWork = aiWorkResult.value || null;
  }
  if (signalsResult.status === "fulfilled") {
    // /api/signals is public on both boxes (API_NO_LOGIN_REQUIRED), so this needs no
    // session — the same reason the healer and risk probes above work.
    //
    // Deliberately does NOT set reachable: that route is a bare in-memory dump
    // (res.json(signalCache)) and answers even when the healer and risk routes are
    // failing. Letting it prove reachability would turn a degraded box into one that
    // reports reachable with every state field null — suppressing the "not answering"
    // action item while nothing else fires either.
    peer.barFreshness = summarizeBarFreshness(signalsResult.value);
  } else {
    // A peer that answers its healer but not its signals is NOT a peer whose bars are
    // unverified — those two must not render alike. The probe is cached for 30s, so an
    // unearned claim about the other box's broker feed would also persist.
    peer.barFreshness = {
      checked: false, staleAssets: [], worst: null,
      judgedAssets: [], unjudgedAssets: [], judgedAt: null, probeFailed: true,
      reason: "the peer's /api/signals did not answer: "
        + String(signalsResult.reason?.message || signalsResult.reason).slice(0, 120),
    };
  }
  if (!peer.reachable) {
    const firstFailure = [healerResult, riskResult, settingsResult, aiWorkResult, signalsResult].find(r => r.status === "rejected");
    peer.error = firstFailure
      ? String(firstFailure.reason?.message || firstFailure.reason).slice(0, 200)
      : "no response";
  }

  // Bridge liveness per account tag, using the same authoritative heartbeat test
  // this box uses on itself — a process list is not a substitute on either machine.
  if (peer.reachable && peer.accountTags.length > 0) {
    const bridgeResults = await Promise.allSettled(
      peer.accountTags.map(tag => getJson("/api/mt5/health?account=" + encodeURIComponent(tag)))
    );
    bridgeResults.forEach((result, index) => {
      const tag = peer.accountTags[index];
      if (result.status === "fulfilled" && result.value?.connected === true) peer.bridges.reporting.push(tag);
      else peer.bridges.silent.push(tag);
    });
  }

  peerProbeCache = { at: Date.now(), value: peer };
  return peer;
}

// Last engine-parity verdict, written only when vps_parity.cjs is run with --emit.
// The comparison itself stays a deliberate manual act; this just stops its answer
// from living exclusively in a terminal scrollback nobody re-reads.
function readParityResult() {
  const parityPath = path.join(__dirname, "..", "tasks", "logs", "vps_parity_last.json");
  try {
    if (!fs.existsSync(parityPath)) {
      return { available: false, reason: "never run — node tasks/vps_parity.cjs --emit" };
    }
    const saved = JSON.parse(fs.readFileSync(parityPath, "utf8"));
    const ranAt = saved.ranAt ? new Date(saved.ranAt) : null;
    const ageHours = ranAt && !isNaN(ranAt.getTime()) ? (Date.now() - ranAt.getTime()) / 3600000 : null;
    return {
      available:   true,
      ranAt:       saved.ranAt ?? null,
      ageHours:    ageHours === null ? null : Math.round(ageHours * 10) / 10,
      engineDrift: saved.engineDrift ?? null,
      scalarDrift: saved.scalarDrift ?? null,
      fileDrift:   saved.fileDrift ?? null,
      // The names behind those counts. Absent from any record written before
      // 2026-08-23, so an older file yields [] rather than undefined and a reader can
      // tell "none differ" from "this run did not record which" by comparing the array
      // against the count. Defaulted here rather than at each caller so one stale file
      // cannot make a page throw.
      filesDiffering:   Array.isArray(saved.filesDiffering)   ? saved.filesDiffering   : [],
      enginesDiffering: Array.isArray(saved.enginesDiffering) ? saved.enginesDiffering : [],
      scalarsDiffering: Array.isArray(saved.scalarsDiffering) ? saved.scalarsDiffering : [],
      verdict:     saved.verdict ?? null,
    };
  } catch (e) {
    return { available: false, reason: "unreadable: " + e.message };
  }
}

// Measured, so "no log rotation" can carry a number and stop being a permanent
// line of furniture on the page.
function readLogDirSizeMB() {
  const logDir = path.join(__dirname, "..", "tasks", "logs");
  try {
    const totalBytes = fs.readdirSync(logDir).reduce((sum, name) => {
      try {
        const stat = fs.statSync(path.join(logDir, name));
        return sum + (stat.isFile() ? stat.size : 0);
      } catch (_) { return sum; }
    }, 0);
    return Math.round(totalBytes / (1024 * 1024) * 10) / 10;
  } catch (_) {
    return null;
  }
}

// Things only a human can clear, split two ways.
//
// actionItems are conditions that CAN clear; standingNotes are true, accepted and
// waiting on nobody today. The split exists because three of the four items here
// were previously unconditional — "Bridge B disabled" fires forever on a box that
// deliberately runs one account — so the panel meant to demand attention sat
// permanently at three and taught you to skim past the one that mattered.
// Nothing was dropped in the split: every original item is still produced, and
// each now states the condition that would retire it.
function deriveActionItems(context) {
  const {
    expectedAccounts, reportingAccounts,
    localHalted, localHaltReason, localGate, localSettingsError,
    peer, parity, backup, logDirSizeMB, heartbeats,
  } = context;

  const actionItems   = [];
  const standingNotes = [];

  const missingBridges = expectedAccounts.filter(tag => !reportingAccounts.includes(tag));
  if (missingBridges.length > 0) {
    actionItems.push({
      severity: "high",
      title: `Bridge ${missingBridges.join(", ")} expected but not reporting`,
      detail: "A bridge this deployment declares as required is silent. Check its terminal login and the bridge log.",
    });
  }

  if (localHalted) {
    actionItems.push({
      severity: "high",
      title: "Circuit breaker open on this box",
      detail: (localHaltReason || "Trading is halted here.") + " Nothing on this box trades until it is cleared, and an absence of trades looks exactly like a quiet market.",
    });
  }

  if (localSettingsError) {
    actionItems.push({
      severity: "high",
      title: "This box is running built-in defaults, not the saved config",
      detail: `strategy_settings.json did not load (${localSettingsError}). Every number on every page describes defaults, and live position sizing is not what the file says.`,
    });
  }

  if (peer.configured && !peer.reachable) {
    actionItems.push({
      severity: "high",
      title: "The other box is not answering",
      detail: `${peer.url} did not respond (${peer.error || "no response"}). That is the box trading continuously, so its silence is not a quiet market — check it before reading any number here as the fleet's.`,
    });
  }

  if (peer.reachable) {
    if (peer.halted) {
      actionItems.push({
        severity: "high",
        title: "Circuit breaker open on the other box",
        detail: (peer.haltReason || "Trading is halted there.") + " The box that trades continuously is not trading, and nothing on this machine would have told you.",
      });
    }
    if (peer.settingsError) {
      actionItems.push({
        severity: "high",
        title: "The other box is running built-in defaults, not its saved config",
        detail: `Its strategy_settings.json did not load (${peer.settingsError}). It is sizing and gating on defaults right now.`,
      });
    }
    if (peer.gate !== null && localGate !== null && peer.gate !== localGate) {
      actionItems.push({
        severity: "high",
        title: `Confidence gate differs across the fleet — ${localGate} here, ${peer.gate} there`,
        detail: "strategy_settings.json is per-machine and untracked, so a shared commit does not mean shared behaviour. The two boxes will admit different trades from identical bars, and any conclusion pooling their journals is unattributable.",
      });
    }
    if (peer.bridges.silent.length > 0) {
      actionItems.push({
        severity: "high",
        title: `Bridge ${peer.bridges.silent.join(", ")} silent on the other box`,
        detail: "That box declares the account but no heartbeat is arriving from its bridge. Check its MT5 terminal login and bridge log.",
      });
    }
    if (peer.healthy === false) {
      actionItems.push({
        severity: "medium",
        title: "The other box reports degraded health",
        detail: "Its own healer is not returning healthy. Open its /plan or /api/healer for which check is failing.",
      });
    }
  }

  if (parity.available && (parity.engineDrift > 0 || parity.scalarDrift > 0)) {
    actionItems.push({
      severity: "high",
      title: "The two boxes do not run the same engine",
      detail: `${parity.engineDrift} engine function(s) and ${parity.scalarDrift} constant(s) differ as of the last parity run${parity.ageHours !== null ? ` (${parity.ageHours}h ago)` : ""}. They can produce different signals from identical bars — reconcile before drawing any conclusion that pools both boxes.`,
    });
  } else if (!parity.available) {
    actionItems.push({
      severity: "low",
      title: "Engine parity has never been recorded",
      detail: `${parity.reason}. Until it runs, nothing on this page proves the two boxes share a trading engine — only that both are up.`,
    });
  } else if (parity.ageHours !== null && parity.ageHours > PARITY_STALE_DAYS * 24) {
    actionItems.push({
      severity: "low",
      title: `Engine parity last checked ${Math.round(parity.ageHours / 24)} days ago`,
      detail: "The VPS carries commits this repo has never seen and its index.js is patched by hand, so parity decays with every deploy. Re-run node tasks/vps_parity.cjs --emit.",
    });
  }

  // A box that stops checking in. This is the ONLY signal that survives a machine
  // the other one cannot reach — the laptop is not addressable from outside, so if
  // it sleeps, Bridge A stops trading and the absence of trades looks exactly like
  // a quiet market. The channel existed since 2026-08-03 and delivered nothing
  // until 2026-08-10: every push was rejected 401 by the auth middleware on the
  // receiving box, and the only record was one line in a monitor log.
  if (heartbeats.missing.length > 0) {
    actionItems.push({
      severity: "high",
      title: `${heartbeats.missing.join(", ")} has not checked in`,
      detail: `Declared in PEER_HEARTBEAT_EXPECT and silent for more than ${heartbeats.staleAfterMinutes} minutes. That box cannot be reached from here, so its silence is the only symptom you get — and a sleeping machine's bridge stops trading without anything looking wrong.`,
    });
  }
  if (heartbeats.stale.length > 0) {
    actionItems.push({
      severity: "high",
      title: `${heartbeats.stale.join(", ")} stopped checking in`,
      detail: `Last check-in is older than ${heartbeats.staleAfterMinutes} minutes. It was reporting and is not now — check whether the machine is asleep, shut, or has lost its network.`,
    });
  }
  // Divergence detected from a PUSH. The always-on box cannot pull from the laptop,
  // so until the check-in carried state, the one box that runs continuously could
  // never tell that its partner was gating trades differently.
  for (const beat of heartbeats.seen) {
    const reported = beat.state;
    if (!reported || beat.stale) continue;
    if (reported.gate !== null && localGate !== null && reported.gate !== localGate) {
      actionItems.push({
        severity: "high",
        title: `Confidence gate differs — ${localGate} here, ${reported.gate} on ${beat.box}`,
        detail: "Reported by that box's own check-in. strategy_settings.json is per-machine and untracked, so a shared commit does not mean shared behaviour: the two boxes admit different trades from identical bars and their journals cannot be pooled.",
      });
    }
    if (reported.halted) {
      actionItems.push({
        severity: "high",
        title: `Circuit breaker open on ${beat.box}`,
        detail: (reported.haltReason || "Trading is halted there.") + " Reported by its own check-in — nothing here can reach that box to ask.",
      });
    }
    if (reported.settingsError) {
      actionItems.push({
        severity: "high",
        title: `${beat.box} is running built-in defaults, not its saved config`,
        detail: `Its strategy_settings.json did not load (${reported.settingsError}). It is sizing and gating on defaults right now.`,
      });
    }
    if ((reported.bridgesSilent || []).length > 0) {
      actionItems.push({
        severity: "high",
        title: `Bridge ${reported.bridgesSilent.join(", ")} silent on ${beat.box}`,
        detail: "That box declares the account and reports no heartbeat from its bridge. Its trades are not being placed.",
      });
    }
  }

  if (heartbeats.expected.length === 0) {
    standingNotes.push({
      severity: "low",
      title: "No box is expected to check in here",
      detail: "PEER_HEARTBEAT_EXPECT is unset, so nothing raises an alarm if the other machine goes quiet. Correct on a box nothing can push to; on the always-on box, list the machines that must report in.",
    });
  }

  const backupAgeHours = backup ? (Date.now() - new Date(backup.modified).getTime()) / 3600000 : null;
  if (!backup) {
    actionItems.push({
      severity: "medium",
      title: "No backup found",
      detail: "Nothing in the backup directory. The learning data and journal represent weeks of real trades and exist on one disk right now.",
    });
  } else if (backupAgeHours !== null && backupAgeHours > BACKUP_STALE_HOURS) {
    actionItems.push({
      severity: "medium",
      title: `Latest backup is ${Math.round(backupAgeHours)}h old`,
      detail: `Newest archive is ${backup.name}. Anything learned since then exists on one disk only.`,
    });
  }

  if (logDirSizeMB !== null && logDirSizeMB > LOG_DIR_WARN_MB) {
    actionItems.push({
      severity: "medium",
      title: `tasks/logs has reached ${logDirSizeMB} MB and nothing trims it`,
      detail: `Past the ${LOG_DIR_WARN_MB} MB mark this raises at. Rotate or archive it.`,
    });
  } else {
    standingNotes.push({
      severity: "low",
      title: "No log rotation",
      detail: `tasks/logs grows without bound — ${logDirSizeMB === null ? "size unreadable" : logDirSizeMB + " MB"} today, under the ${LOG_DIR_WARN_MB} MB mark that turns this into an action. Nothing trims it.`,
    });
  }

  if (!expectedAccounts.includes("B")) {
    standingNotes.push({
      severity: "low",
      title: "Bridge B disabled — needs a second demo account",
      detail: "This machine holds one broker account. Two bridges on one account would place every trade twice at double risk, so B stays off until a second account exists. Then set MT5_EXPECTED_LOGIN in start_bridge_B_vps.bat and MT5_EXPECTED_ACCOUNTS=A,B. Deliberate, not a fault — it retires itself the moment that variable lists B.",
    });
  }

  standingNotes.push({
    severity: "low",
    title: "Voice needs a trusted origin",
    detail: "Chrome allows the microphone only on HTTPS or localhost. Use the SSH tunnel at localhost:3002, or finish the cloudflared tunnel for a real HTTPS URL that also works on a phone.",
  });

  return { actionItems, standingNotes };
}

app.get("/api/system-plan", async (_, res) => {
  try {
    const healer = autohealer.getStatus();

    // Both are slow and independent, so neither should wait on the other. Each
    // resolves to an "unavailable" shape rather than rejecting, so a dead peer or a
    // schtasks timeout degrades one card instead of 500-ing the page.
    const [taskInfo, peer] = await Promise.all([readScheduledTasks(), probePeer()]);

    const reportingAccounts = Object.entries(mt5LastSeenByAccount)
      .filter(([, seenAt]) => Date.now() - new Date(seenAt).getTime() < MT5_HEARTBEAT_STALE_MS)
      .map(([tag]) => tag);

    const expectedAccounts = (process.env.MT5_EXPECTED_ACCOUNTS ?? "A,B")
      .split(",").map(tag => tag.trim()).filter(Boolean);

    const localGate     = typeof strategySettings?.confidenceThreshold === "number" ? strategySettings.confidenceThreshold : null;
    const localLotSize  = typeof strategySettings?.fixedLotSize === "number" ? strategySettings.fixedLotSize : null;
    const parity        = readParityResult();
    const backup        = readLatestBackup();
    const logDirSizeMB  = readLogDirSizeMB();
    const heartbeats    = assessHeartbeats(Math.round(process.uptime()));

    const { actionItems, standingNotes } = deriveActionItems({
      expectedAccounts,
      reportingAccounts,
      localHalted:        riskStatus.halted === true,
      localHaltReason:    riskStatus.haltReason || "",
      localGate,
      localSettingsError: strategySettingsError || null,
      peer, parity, backup, logDirSizeMB, heartbeats,
    });

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
      latestBackup: backup,
      logDirSizeMB,
      // What THIS box believes, stated in the same shape as the peer so the page can
      // put them side by side and the comparison is not done by eye across two cards.
      thisBox: {
        label: os.hostname(),
        healthy: healer.healthy,
        gate: localGate,
        fixedLotSize: localLotSize,
        settingsError: strategySettingsError || null,
        halted: riskStatus.halted === true,
        haltReason: riskStatus.haltReason || "",
        dailyPnl: riskStatus.dailyPnl ?? null,
        consecutiveLosses: riskStatus.consecutiveLosses ?? null,
        bridges: {
          reporting: reportingAccounts,
          silent: expectedAccounts.filter(tag => !reportingAccounts.includes(tag)),
        },
        // Read from signalCache in process — the object /api/signals serves verbatim —
        // so this box is judged from exactly the payload the peer probe reads remotely,
        // without a server calling its own HTTP port.
        barFreshness: summarizeBarFreshness(signalCache),
      },
      peer,
      divergence: {
        // The gate lives in a per-machine file, which is exactly why a mismatch is
        // dangerous rather than expected: it decides what trades, and no commit syncs it.
        gate: peer.reachable && peer.gate !== null && localGate !== null
          ? { local: localGate, peer: peer.gate, differs: peer.gate !== localGate }
          : null,
        // Per-machine BY DESIGN — the VPS deliberately runs a fixed 0.01. Reported so
        // it is visible, never raised as a fault.
        fixedLotSize: peer.reachable && peer.fixedLotSize !== null && localLotSize !== null
          ? { local: localLotSize, peer: peer.fixedLotSize, differs: peer.fixedLotSize !== localLotSize, byDesign: true }
          : null,
        engine: parity.available
          ? {
              differs: (parity.engineDrift > 0 || parity.scalarDrift > 0),
              engineDrift: parity.engineDrift,
              scalarDrift: parity.scalarDrift,
              fileDrift: parity.fileDrift,
              ranAt: parity.ranAt,
              ageHours: parity.ageHours,
            }
          : null,
      },
      parity,
      // Push liveness, kept alongside the pull probe: this is the only signal that
      // survives a box the other one cannot reach.
      heartbeats,
      actionItems,
      standingNotes,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/now — what time it is, and how long ago everything happened ─────────
//
// Nothing here ever answered "when". The logs are LOCAL time, every API is UTC, and
// on 2026-08-10 that cost a near-miss: bridge_log_A.txt read 16:17 while /api/status
// said 13:38Z and the log looked corrupt or the clock wrong. It was BST. A system
// that reasons about market sessions, bar staleness and "has this fired in 7 days"
// cannot hold time as an afterthought.
//
// Ages are the point. "Signal cache updated 2026-08-10T13:38Z" needs arithmetic to
// act on; "4 minutes ago" does not — and the mistakes this system has actually made
// were staleness mistakes: a wedged terminal staying green, positions reading zero
// after a restart, a bridge that had not pushed in an hour looking identical to a
// quiet market.
const MS = { minute: 60000, hour: 3600000, day: 86400000 };

/** "3h 12m ago" — the form a human acts on, alongside the ISO the machine needs. */
function humanAge(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 0) return "in the future";
  if (ms < 45 * 1000) return "just now";
  const days = Math.floor(ms / MS.day);
  const hours = Math.floor((ms % MS.day) / MS.hour);
  const minutes = Math.floor((ms % MS.hour) / MS.minute);
  if (days > 0)  return `${days}d ${hours}h ago`;
  if (hours > 0) return `${hours}h ${minutes}m ago`;
  return `${minutes}m ago`;
}

/** Every timestamp on this system is reported the same way: when, how long, in words. */
function ageOf(timestamp) {
  if (!timestamp) return { at: null, ageMs: null, human: "never" };
  const at = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (isNaN(at.getTime())) return { at: null, ageMs: null, human: "unreadable" };
  const ageMs = Date.now() - at.getTime();
  return { at: at.toISOString(), ageMs, human: humanAge(ageMs) };
}

/** ISO-8601 week number — the unit weekly jobs and weekly reviews are keyed to. */
function isoWeek(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;          // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);  // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  return 1 + Math.round((target - firstThursday) / (7 * MS.day));
}

// UTC hour boundaries, matching getCurrentSession above so the two can never drift.
const SESSION_SCHEDULE = [
  { name: "ASIAN",      startUtcHour: 22, endUtcHour: 7  },
  { name: "PRE-LONDON", startUtcHour: 7,  endUtcHour: 9  },
  { name: "LONDON",     startUtcHour: 9,  endUtcHour: 12 },
  { name: "OVERLAP",    startUtcHour: 12, endUtcHour: 13 },
  { name: "NEW YORK",   startUtcHour: 13, endUtcHour: 17 },
  { name: "AFTER HOURS",startUtcHour: 17, endUtcHour: 22 },
];

function nextSessionTransition(now) {
  const boundaries = [...new Set(SESSION_SCHEDULE.map(s => s.startUtcHour))].sort((a, b) => a - b);
  const hour = now.getUTCHours();
  const nextHour = boundaries.find(h => h > hour);
  const at = new Date(now);
  at.setUTCMinutes(0, 0, 0);
  if (nextHour === undefined) { at.setUTCDate(at.getUTCDate() + 1); at.setUTCHours(boundaries[0]); }
  else at.setUTCHours(nextHour);
  const session = SESSION_SCHEDULE.find(s => s.startUtcHour === at.getUTCHours());
  return { name: session ? session.name : "unknown", atUtc: at.toISOString(), inMinutes: Math.round((at - now) / MS.minute) };
}

app.get("/api/now", (_, res) => {
  try {
    const now = new Date();
    const localOffsetMinutes = -now.getTimezoneOffset();   // JS reports the inverse
    // DST by comparison with January and July — no library, no assumption about
    // which hemisphere this box is in.
    const january = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const july    = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    const isDST   = now.getTimezoneOffset() < Math.max(january, july);

    const dayMs = MS.day;
    const isoDate = (d) => d.toISOString().slice(0, 10);
    const weekday = now.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
    const utcDay = now.getUTCDay();

    const newestTrade = Array.isArray(tradeJournal) && tradeJournal.length
      ? tradeJournal[0].openTime || tradeJournal[0].closeTime || null
      : null;
    const parity = readParityResult();
    const backup = readLatestBackup();

    res.json({
      // Both clocks, always, and the offset between them — because every log on
      // this machine is local and every API on it is UTC.
      now: {
        utc: now.toISOString(),
        local: now.toLocaleString("en-GB", { hour12: false }),
        localTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utcOffsetMinutes: localOffsetMinutes,
        isDST,
        epochMs: now.getTime(),
        unix: Math.floor(now.getTime() / 1000),
      },
      calendar: {
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        monthName: now.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" }),
        day: now.getUTCDate(),
        weekday,
        isoWeek: isoWeek(now),
        quarter: Math.floor(now.getUTCMonth() / 3) + 1,
        dayOfYear: Math.floor((now - new Date(Date.UTC(now.getUTCFullYear(), 0, 0))) / dayMs),
        today:     isoDate(now),
        yesterday: isoDate(new Date(now.getTime() - dayMs)),
        tomorrow:  isoDate(new Date(now.getTime() + dayMs)),
        isWeekend: utcDay === 0 || utcDay === 6,
      },
      session: {
        current: getCurrentSession(),
        next: nextSessionTransition(now),
        schedule: SESSION_SCHEDULE,
        // Clock-derived, NOT broker-verified. Bar freshness below is the evidence.
        note: "Sessions are UTC clock boundaries. Whether a market is actually trading is answered by feed freshness, not by this schedule.",
      },
      // How long ago everything happened, in one place, in both forms.
      ages: {
        serverStarted:  ageOf(SERVER_START),
        signalCache:    ageOf(signalCache?.updatedAt),
        bridges: Object.fromEntries(
          Object.entries(mt5LastSeenByAccount).map(([tag, seenAt]) => [tag, ageOf(seenAt)])
        ),
        lastTrade:      ageOf(newestTrade),
        lastParityRun:  ageOf(parity.available ? parity.ranAt : null),
        lastBackup:     ageOf(backup ? backup.modified : null),
      },
      uptimeSeconds: Math.round(process.uptime()),
      feedsTheGate: false,
    });
  } catch (e) {
    console.error("[now]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/fleet — both boxes, for the panels that decide what is armed ────────
//
// The Auto Trade tab and the AI Employee panel each described ONE machine while
// presenting themselves as the system. Two measured consequences:
//
//   - The mode cards read a browser localStorage value. Whether a bridge actually
//     arms trades is config.autoMode, reported by the bridge that enforces it, and
//     the page never looked at it — on either box.
//   - The AI-employee ledger reads local tasks/logs only. On 2026-08-10 it showed
//     0 unreviewed proposals while the VPS — the box that trades continuously —
//     had 2 sitting unread. An unread recommendation does not stop mattering
//     because it is on the other machine.
//
// Read-only: it composes state this server already holds with a cached pull of the
// peer's public endpoints. Writes nothing, arms nothing, feeds no gate.
const FLEET_COMPARED_SETTINGS = [
  { key: "confidenceThreshold",    label: "Confidence gate",  byDesign: false },
  { key: "minStrength",            label: "Min strength",     byDesign: false },
  { key: "maxConcurrentPositions", label: "Position slots",   byDesign: false },
  { key: "maxTradesPerDay",        label: "Max trades/day",   byDesign: false },
  // Per-machine on purpose: the VPS deliberately runs a fixed 0.01 lot.
  { key: "fixedLotSize",           label: "Fixed lot size",   byDesign: true  },
  { key: "maxLotSize",             label: "Max lot size",     byDesign: true  },
];

/** Arming state per account tag, from the bridge's own reported config. */
function armingFromAccounts(accounts) {
  return Object.entries(accounts || {}).map(([tag, account]) => ({
    tag,
    autoMode:     account?.config?.autoMode === true,
    remoteHalted: account?.config?.remoteHalted === true,
    halted:       account?.halted === true,
    haltReason:   account?.haltReason || "",
    expectedLogin: account?.config?.expectedLogin ?? null,
  }));
}

app.get("/api/fleet", async (_, res) => {
  try {
    const peer = await probePeer();

    let localAiWork = null;
    try { localAiWork = aiWorkLedger.build(); }
    catch (e) { localAiWork = { available: false, reason: e.message, jobs: [], proposals: [] }; }

    const thisBox = {
      label: os.hostname(),
      url: "this box",
      reachable: true,
      settings: { ...strategySettings, settingsError: strategySettingsError || null },
      arming: armingFromAccounts(riskStatusByAccount),
      halted: riskStatus.halted === true,
      haltReason: riskStatus.haltReason || "",
      aiWork: localAiWork,
    };

    // Settings compared field by field, so "the same commit" never gets mistaken
    // for "the same behaviour" — strategy_settings.json is untracked per machine.
    const settingsComparison = FLEET_COMPARED_SETTINGS.map(field => {
      const localValue = strategySettings ? strategySettings[field.key] : null;
      const peerValue  = peer.reachable && peer.settings ? peer.settings[field.key] : null;
      const comparable = localValue !== undefined && localValue !== null
                      && peerValue  !== undefined && peerValue  !== null;
      return {
        key: field.key,
        label: field.label,
        local: localValue ?? null,
        peer: peerValue ?? null,
        differs: comparable ? localValue !== peerValue : false,
        byDesign: field.byDesign,
        comparable,
      };
    });

    const localUnreviewed = localAiWork?.totals?.unreviewed ?? 0;
    const peerUnreviewed  = peer.aiWork?.totals?.unreviewed ?? 0;

    res.json({
      generatedAt: new Date().toISOString(),
      thisBox,
      // Shallow copy: probePeer's result is cached and shared, so the derived
      // arming list is added to the response rather than written back into it.
      peer: { ...peer, arming: armingFromAccounts(peer.accounts) },
      settingsComparison,
      // The number that was wrong: the panel showed only the left-hand side.
      proposals: {
        local: localUnreviewed,
        peer: peer.reachable ? peerUnreviewed : null,
        fleetUnreviewed: localUnreviewed + (peer.reachable ? peerUnreviewed : 0),
      },
      // Editing settings on this page writes THIS box's strategy_settings.json and
      // nothing else. Stated in the payload so the page cannot forget to say it.
      settingsScope: "Saving writes " + os.hostname() + " only. strategy_settings.json is per-machine and untracked — the other box keeps its own.",
      feedsTheGate: false,
    });
  } catch (e) {
    console.error("[fleet]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/doctor — the fleet's findings, each with the command that fixes it ──
//
// READ-ONLY. This serves the diagnosis; it never heals. --heal stays on the CLI
// deliberately: a button that restarts things is a different risk from a page that
// lists them, and nothing on a dashboard should be one click from touching a bridge.
//
// Cached, and single-flight. The cache is the lesser reason: a full pass measures
// ~150-215ms locally, so this is not about latency, and an earlier note here claiming
// /api/ai-work takes 30s was wrong — that was one MCP client timing out, not the
// endpoint, which answers in ~150ms. What the cache actually buys is not hammering the
// PEER on every panel refresh across two boxes.
//
// The single-flight is the load-bearing part and is about CORRECTNESS: diagnose()
// accumulates into a module-level array, so two concurrent runs would interleave into
// one list. The in-flight promise means a burst of readers all wait on the SAME pass.
const DOCTOR_CACHE_MS = 60000;
let doctorCache = { at: 0, report: null };
let doctorInFlight = null;

app.get("/api/doctor", async (_, res) => {
  try {
    const fresh = Date.now() - doctorCache.at < DOCTOR_CACHE_MS;
    if (fresh && doctorCache.report) {
      return res.json({ ...doctorCache.report, cached: true,
                        ageMs: Date.now() - doctorCache.at });
    }
    if (!doctorInFlight) {
      doctorInFlight = fleetDoctor.diagnose()
        .then(report => { doctorCache = { at: Date.now(), report }; return report; })
        .finally(() => { doctorInFlight = null; });
    }
    const report = await doctorInFlight;
    res.json({ ...report, cached: false, ageMs: 0 });
  } catch (e) {
    // A doctor that 500s tells you nothing about the thing it was asked to inspect,
    // which is the one moment you need it. Serve the last good pass and say it is old.
    console.error("[doctor]", e.message);
    if (doctorCache.report) {
      return res.json({ ...doctorCache.report, cached: true, stale: true,
                        ageMs: Date.now() - doctorCache.at, error: e.message });
    }
    res.status(500).json({ error: e.message, findings: [] });
  }
});

// ── /api/measurements — what the harnesses actually found ───────────────────
//
// The measurement work lived only in tasks/analysis/*.json and terminal scrollback, so
// the answer to "when does this system make money" existed and was invisible. This
// serves the LATEST run of each harness, and its AGE, because a measurement whose date
// is hidden is how a stale number gets quoted as current.
//
// Read-only over files the harnesses already write. It runs nothing: these replays take
// minutes and an HTTP request must never kick one off.
const MEASUREMENT_FILES = [
  ["timeHeatmap",  "time-heatmap-latest.json",        "node tasks/time_heatmap.cjs"],
  ["sessionFolds", "session-walkforward-latest.json", "node tasks/session_walkforward.cjs"],
  ["setupFolds",   "setup-walkforward-latest.json",   "node tasks/session_walkforward.cjs --by setup"],
];

app.get("/api/measurements", (_, res) => {
  const out = { generatedAt: new Date().toISOString(), measurements: {}, feedsTheGate: false };
  for (const [key, file, command] of MEASUREMENT_FILES) {
    const full = path.join(__dirname, "..", "tasks", "analysis", file);
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      const ranAt = raw.generatedAt || null;
      const entry = {
        available: true, ranAt, command,
        ageHours: ranAt ? +(((Date.now() - Date.parse(ranAt)) / 3600000).toFixed(1)) : null,
        gate: raw.basis && raw.basis.gate,
        totalTrades: raw.basis && raw.basis.totalTrades,
        // An incomplete replay must travel with the numbers, not sit in a log. SP500
        // silently produced nothing for three harnesses before this was caught.
        failedAssets: Object.entries(raw.perAsset || {})
          .filter(([, v]) => v && v.error).map(([k]) => k),
      };
      if (key === "timeHeatmap") {
        entry.atGateTrades = raw.basis && raw.basis.atGateTrades;
        entry.entryHoursUtc = raw.basis && raw.basis.entryHoursUtc;
        entry.minClosedPerCell = raw.basis && raw.basis.minClosedPerCell;
        entry.sessions = (raw.atLiveGate && raw.atLiveGate.session) || {};
        // The grid itself, both populations. At the live gate most cells are under the
        // per-cell floor, so the floor population is served alongside it — without that
        // the grid is nearly empty and reads as "no data" rather than "too thin to
        // score", which are different statements.
        entry.grid = {
          atGate: {
            blockByDay: (raw.atLiveGate && raw.atLiveGate.blockByDay) || {},
            block: (raw.atLiveGate && raw.atLiveGate.block) || {},
            day: (raw.atLiveGate && raw.atLiveGate.day) || {},
          },
          atFloor: {
            blockByDay: (raw.atConfFloor && raw.atConfFloor.blockByDay) || {},
            block: (raw.atConfFloor && raw.atConfFloor.block) || {},
            day: (raw.atConfFloor && raw.atConfFloor.day) || {},
          },
          confFloor: raw.basis && raw.basis.confFloor,
        };
      } else {
        const view = raw.atLiveGate || {};
        entry.baseline = view.baseline && view.baseline.rpt;
        entry.foldCount = view.foldCount;
        entry.trades = view.trades;
        entry.slices = (view.slices || []).map(s => ({
          slice: s.slice, closed: s.own && s.own.closed, rpt: s.own && s.own.rpt,
          pooledDelta: s.pooledDelta, foldsImproved: s.foldsImproved,
          foldsScored: s.foldsScored, verdict: s.verdict,
        }));
      }
      out.measurements[key] = entry;
    } catch (e) {
      // Absent is a legitimate state — the harness may simply never have run here — so
      // it reports the command that would produce it rather than an error.
      out.measurements[key] = { available: false, command, reason: e.code === "ENOENT"
        ? "never run on this box" : e.message };
    }
  }
  res.json(out);
});

// ── /api/fleet-performance — the whole record, both boxes, POOLED ───────────
//
// The binding constraint on this system is sample size, and every surface halves it.
// Each box journals its OWN fills, so the laptop shows 3 closed trades and the VPS
// shows 3, and the fleet's actual record of 6 appears nowhere. Doubling the visible
// evidence changes nothing about the trading and quite a lot about what can be said.
//
// POOLING IS GATED ON ENGINE PARITY, and that is not a formality. The standing rule
// here is that numbers pooling both boxes are unattributable while the engines differ:
// two boxes running different code admit different trades from identical bars, so
// their fills are not samples of one thing. If parity is missing, stale or divergent
// this returns the boxes SEPARATELY and says why, rather than quietly averaging two
// populations that are not comparable.
const FLEET_PERF_PARITY_STALE_HOURS = 48;

/**
 * Collapse fills that are the SAME market event seen on two boxes.
 *
 * Both machines run the same engine on the same bars, so they take the same trade.
 * Verified 2026-08-07: XAUUSD RANGE_TRADE_SHORT opened 07:00 here and 08:00 there,
 * entries $6 apart, losses of -99.10 and -98.31. That is one Gold short observed
 * twice, and counting it as two samples would reach the learning engine's 5-trade
 * floor on half the real information.
 *
 * The rule is OVERLAPPING EXPOSURE, not a time bucket: same symbol, same direction,
 * same setup, and the two positions open at the same time. An earlier draft used "same
 * H4 bar" and would have missed this exact pair, because 07:00 and 08:00 fall in
 * different H4 bars while describing one trade.
 *
 * Different instrument or non-overlapping windows stay separate — BB_SQUEEZE_WATCH is
 * XAUUSD on 07-30 here and BTCUSD on 08-06 there, which are genuinely two observations.
 *
 * A cluster whose fills disagree is reported as SPLIT rather than silently averaged:
 * the same setup on the same instrument at the same time resolving differently on two
 * boxes is an execution divergence, and that is worth seeing, not smoothing.
 */
function collapseCorrelated(trades) {
  const windowOf = (t) => {
    const open = Date.parse(t.openTime);
    const close = t.closeTime ? Date.parse(t.closeTime) : Number.POSITIVE_INFINITY;
    return Number.isFinite(open) ? [open, close] : null;
  };
  const groups = new Map();
  for (const t of trades) {
    const key = `${t.symbol}|${t.direction}|${t.setup}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(t);
  }

  const clusters = [];
  for (const [, rows] of groups) {
    const dated = rows.map(t => ({ t, w: windowOf(t) })).filter(x => x.w);
    const undated = rows.filter(t => !windowOf(t));
    dated.sort((a, b) => a.w[0] - b.w[0]);

    let current = null;
    for (const { t, w } of dated) {
      // Overlap, not adjacency: [openA, closeA] must intersect [openB, closeB].
      if (current && w[0] <= current.end) {
        current.fills.push(t);
        current.end = Math.max(current.end, w[1]);
      } else {
        current = { fills: [t], end: w[1] };
        clusters.push(current);
      }
    }
    // A fill with no readable open time cannot be proven correlated with anything, so
    // it stands alone rather than being folded in on a guess.
    for (const t of undated) clusters.push({ fills: [t], end: 0 });
  }

  return clusters.map(c => {
    const wins = c.fills.filter(t => t.pnl > 0).length;
    const outcome = wins === c.fills.length ? "WIN" : wins === 0 ? "LOSS" : "SPLIT";
    return {
      setup: c.fills[0].setup, symbol: c.fills[0].symbol, direction: c.fills[0].direction,
      fills: c.fills.length,
      boxes: [...new Set(c.fills.map(t => t.box))],
      outcome,
      // The representative P&L of one observation is the mean of the fills that
      // reported it. Summing would restate one event's cost as two.
      pnl: +(c.fills.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0) / c.fills.length).toFixed(2),
      openedAt: c.fills[0].openTime,
    };
  });
}

function poolStats(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const net = trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  return {
    closed: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : null,
    netPnl: +net.toFixed(2),
    // Expectancy over six trades is a number, not a fact. It is returned because the
    // caller will compute it anyway, and withheld from meaning by sampleWarning below.
    expectancy: trades.length ? +(net / trades.length).toFixed(2) : null,
  };
}

app.get("/api/fleet-performance", async (_, res) => {
  try {
    const localClosed = tradeJournal
      .filter(t => t && t.status === "CLOSED" && typeof t.pnl === "number")
      .map(t => ({ ...t, box: "this box" }));

    let parity = null;
    try {
      parity = JSON.parse(fs.readFileSync(
        path.join(__dirname, "..", "tasks", "logs", "vps_parity_last.json"), "utf8"));
    } catch (e) { parity = null; }
    const parityAgeHours = parity && parity.ranAt
      ? (Date.now() - Date.parse(parity.ranAt)) / 3600000 : null;
    const enginesAgree = Boolean(parity && parity.verdict === "ENGINES AGREE");
    const parityFresh = Number.isFinite(parityAgeHours) && parityAgeHours <= FLEET_PERF_PARITY_STALE_HOURS;

    // axios with an explicit 200-only validator, matching probePeer(). A 401 or a 502
    // parses cleanly as JSON and would otherwise be pooled as if it were a journal.
    const peerUrl = String(process.env.PEER_SERVER_URL || "").trim().replace(/\/+$/, "");
    let peerClosed = null, peerError = null;
    if (peerUrl) {
      try {
        const response = await axios.get(peerUrl + "/api/journal?limit=100",
          { timeout: 8000, validateStatus: (status) => status === 200 });
        const rows = response.data && response.data.journal;
        if (Array.isArray(rows)) {
          peerClosed = rows
            .filter(t => t && t.status === "CLOSED" && typeof t.pnl === "number")
            .map(t => ({ ...t, box: "peer" }));
        } else {
          peerError = "peer returned no journal array";
        }
      } catch (e) {
        peerError = e.message;
      }
    }

    const poolable = enginesAgree && parityFresh && Array.isArray(peerClosed);
    const all = poolable ? [...localClosed, ...peerClosed] : localClosed;

    // Per setup, across whatever population is legitimate. This is the number the
    // learning engine starves for: it needs 5 closed trades in ONE setup bucket before
    // it will act, and no single box is close.
    // NON_SETUP_NAMES excluded here too. This table is explicitly the one read to judge
    // how close a setup is to the 5-closed-trade threshold the learning engine needs, so
    // a phantom bucket does not just look wrong — it makes a non-setup appear to be
    // approaching the bar, on the one screen that pools BOTH boxes.
    //
    // Reported, never dropped: the fleet and per-box totals below still count these
    // trades, and `unattributed` names them.
    const bySetup = {};
    const unattributedFleet = [];
    for (const t of all) {
      if (!t.setup || NON_SETUP_NAMES.has(String(t.setup).trim().toUpperCase())) {
        unattributedFleet.push(t);
        continue;
      }
      (bySetup[t.setup] = bySetup[t.setup] || []).push(t);
    }

    res.json({
      pooled: poolable,
      whyNotPooled: poolable ? null
        : !peerUrl ? "no PEER_SERVER_URL on this box, so the peer cannot be read from here"
        : peerError ? `peer unreachable: ${peerError}`
        : !parity ? "engine parity has never been recorded, so the two records are not known to be comparable"
        : !enginesAgree ? `engine parity says ${parity.verdict} — the boxes admit different trades from identical bars`
        : `engine parity is ${parityAgeHours.toFixed(1)}h old, past the ${FLEET_PERF_PARITY_STALE_HOURS}h freshness bar`,
      parity: parity ? {
        verdict: parity.verdict, ranAt: parity.ranAt,
        ageHours: parityAgeHours === null ? null : +parityAgeHours.toFixed(1),
      } : null,
      fleet: poolStats(all),
      // Counted in `fleet` and `byBox` above, excluded from bySetup below. Named here so
      // the two can be reconciled instead of read as a discrepancy.
      unattributed: {
        count: unattributedFleet.length,
        totalPnl: parseFloat(unattributedFleet.reduce((sum, t) => sum + (t.pnl || 0), 0).toFixed(2)),
        why: "Closed trades whose setup name is missing or is WAIT/NONE/UNKNOWN — the absence "
           + "of a setup, not a setup. Included in the fleet and per-box totals, excluded from "
           + "bySetup so nothing counts toward a setup's progress to the 5-trade threshold "
           + "that did not come from that setup.",
      },
      byBox: {
        "this box": poolStats(localClosed),
        peer: peerClosed ? poolStats(peerClosed) : null,
      },
      bySetup: Object.fromEntries(Object.entries(bySetup).map(([k, v]) => {
        const clusters = collapseCorrelated(v);
        const wins = clusters.filter(c => c.outcome === "WIN").length;
        const losses = clusters.filter(c => c.outcome === "LOSS").length;
        const split = clusters.filter(c => c.outcome === "SPLIT").length;
        return [k, {
          ...poolStats(v),
          boxes: [...new Set(v.map(t => t.box))],
          // RAW is fills; INDEPENDENT is market events. The gap between them is the
          // amount by which a naive pool would have overstated the evidence.
          independent: {
            observations: clusters.length,
            wins, losses, split,
            duplicatesCollapsed: v.length - clusters.length,
            clusters: clusters.map(c => ({
              symbol: c.symbol, direction: c.direction, fills: c.fills,
              boxes: c.boxes, outcome: c.outcome, pnl: c.pnl, openedAt: c.openedAt,
            })),
          },
          // The learning engine's floor, measured in INDEPENDENT observations. Counting
          // fills here is how one Gold short would fill the bucket twice as fast.
          towardLearningFloor: `${clusters.length}/5`,
          towardLearningFloorRawFills: `${v.length}/5`,
        }];
      })),
      // Stated once, at the top level, because it is the reason this endpoint does not
      // simply feed getLearningBoost: the raw pooled counts are not what they look like.
      dedupNote: "towardLearningFloor counts INDEPENDENT market events. Both boxes run "
        + "the same engine on the same bars, so they take the same trade — fills with "
        + "overlapping exposure on one symbol, direction and setup collapse to one "
        + "observation. Nothing here feeds live confidence; getLearningBoost still reads "
        + "this box's learning.json only.",
      // Said out loud, every time. Six closed trades cannot support a claim about edge,
      // and a win rate printed without this line invites exactly that claim.
      sampleWarning: all.length < 30
        ? `${all.length} closed trades across the fleet. Far too few for any claim about edge — `
          + "read this as a record of what happened, not as a measurement of what works."
        : null,
      feedsTheGate: false,
    });
  } catch (e) {
    console.error("[fleet-performance]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/cohort-reachability — which cohorts can reach the gate AT ALL ──────
//
// The answer to "why does it so rarely trade" is often not that the market is quiet:
// it is that the cohort a setup lands in has a ceiling BELOW the gate, so it could
// never have fired however good the setup was. The boot log has said this for a while
// and nothing on a screen did.
//
// Computed by cohort_table.computeReachability — the SAME call the boot check makes,
// with the SAME live settings. Deliberately not re-derived here and emphatically not
// re-derived in the dashboard: index.html once hardcoded 65 in five places while the
// gate was 70 and every displayed gap was 5pt short. One implementation, or it drifts.
app.get("/api/cohort-reachability", (_, res) => {
  try {
    const rows = cohortTable.computeReachability(
      strategySettings.confidenceThreshold,
      strategySettings.dailyOnlyMinConfidence
    );
    const blocking = rows.filter(r => r.status === "DEAD" || r.status === "BLOCKED (MEASURED)");
    res.json({
      gate: strategySettings.confidenceThreshold,
      dailyOnlyMinConfidence: strategySettings.dailyOnlyMinConfidence,
      maxBoost: cohortTable.MAX_BOOST,
      total: rows.length,
      unreachable: blocking.length,
      rows,
      // Stated rather than implied: a DEAD cohort is not necessarily a WRONG one. SPX
      // H4-only is blocked deliberately because every slice measured negative
      // out-of-sample, and that is a different fact from a cohort dying by accident.
      note: "DEAD = ceiling below the gate, so it can never fire however good the setup. "
          + "BLOCKED (MEASURED) = deliberately floored after measuring negative. "
          + "Dead does not imply wrongly dead.",
      feedsTheGate: false,
    });
  } catch (e) {
    console.error("[cohort-reachability]", e.message);
    res.status(500).json({ error: e.message, rows: [] });
  }
});

// ── /api/strategy-board — every setup, and every source of truth about it ───
//
// The engine emits eight setup names and the evidence about them lived in four
// places that never met: learning.json (real fills), learning_shadow.json (forgone
// paper trades), the rejection ledger (which gate killed it), and the evidence
// register (what has actually been measured). No page joined them, so the honest
// answer to "which of my strategies work" was to open four screens and do it by
// hand. This is that join, and nothing more: read-only, session-gated by the
// /api/ rule, feedsTheGate false.
//
// The one thing it must never do is blur live and paper together. A shadow row is
// a trade that was NEVER FILLED - no spread, no slippage, a fixed scoring horizon.
// Folding it into a win rate would make a paper result indistinguishable from
// money, which is the same mistake that once filed a real -449.72 fill under a
// watch-only setup name. They stay in separate columns, always.
app.get("/api/strategy-board", (_, res) => {
  try {
    // Every name the engine can emit. Hardcoded deliberately: a setup that has
    // never fired must still appear, and deriving the list from the data would
    // hide exactly the ones with no history - the rows most worth seeing.
    // ALL TEN the engine can emit. It was eight when this shipped on 2026-08-25 and
    // BUY_DIP and BREAKOUT were simply missing - a board whose whole purpose is "here
    // are your strategies" that silently showed 8 of 10. Derived by hand from the
    // `setup  = "NAME"` assignments in generateSignal; if a setup is added there it
    // must be added here, and the count check below is what will catch it next time.
    const KNOWN_SETUPS = [
      "MOMENTUM", "TREND_FOLLOW", "SQUEEZE_BREAKOUT", "BUY_OVERSOLD",
      "SELL_BOUNCE", "RANGE_TRADE_LONG", "RANGE_TRADE_SHORT", "BB_SQUEEZE_WATCH",
      "BUY_DIP", "BREAKOUT",
    ];
    // Below this many closed fills a win rate is noise, not a verdict. Same floor
    // the learning engine uses to withhold a boost.
    const LIVE_JUDGEMENT_FLOOR = 5;

    // ── live fills, from the journal, which is the record that cannot drift ──
    // R is derived from the FILLED PRICES, never from the stored r:r - journal.rr
    // was the SIGNAL'S PLAN, not the outcome, and reading it as realised was a real
    // bug this project already shipped once.
    const live = {};
    for (const t of tradeJournal) {
      if (t.status !== "CLOSED") continue;
      const name = t.setup;
      // WAIT/NONE/UNKNOWN is the ABSENCE of a setup, not a setup. Counting it
      // would invent a ninth strategy out of a missing field.
      if (!name || !KNOWN_SETUPS.includes(name)) continue;
      const row = live[name] || (live[name] = {
        trades: 0, wins: 0, losses: 0, pnl: 0, realizedR: 0, rTrades: 0,
      });
      row.trades += 1;
      if (t.pnl !== null && t.pnl !== undefined) {
        if (t.pnl > 0) row.wins += 1; else row.losses += 1;
        row.pnl += t.pnl;
      }
      // realizedR is NOT stored on the journal row - it is derived at read time by
      // realizedRFromPrices, the server's own single implementation, which is why
      // /api/journal shows it and the file on disk does not. Called here rather than
      // recomputed: a second copy of "what did this trade actually return" is exactly
      // how journal.rr came to be read as an outcome when it was only the plan.
      const derivedR = t.closePrice == null
        ? null
        : realizedRFromPrices(t.direction, t.entry, t.sl, t.closePrice);
      if (Number.isFinite(derivedR)) { row.realizedR += derivedR; row.rTrades += 1; }
    }

    // ── shadow: forgone paper trades, read from the same file /api/learning uses ──
    let shadowStats = {};
    let shadowAgeHours = null;
    let shadowError = null;
    try {
      const shadowPath = path.join(__dirname, "learning_shadow.json");
      if (fs.existsSync(shadowPath)) {
        const raw = JSON.parse(fs.readFileSync(shadowPath, "utf8"));
        shadowStats = raw.shadowStats || {};
        const ms = typeof raw.generatedAt === "string" ? Date.parse(raw.generatedAt) : NaN;
        shadowAgeHours = Number.isFinite(ms)
          ? Math.round(((Date.now() - ms) / 3600000) * 10) / 10 : null;
      }
    } catch (e) {
      // Surfaced, never swallowed: a stalled nightly regeneration is exactly the
      // kind of failure that reads as "no evidence" instead of "stale evidence".
      shadowError = e.message;
      console.error(`[strategy-board] shadow unreadable (${e.message})`);
    }

    // ── which gate killed it, from the rejection ledger ──
    let killedBy = {};
    let ledgerError = null;
    try {
      const eviction = rejectionEvidence.buildEvidence();
      for (const [name, row] of Object.entries(eviction.setups || {})) {
        killedBy[name] = row.gates || {};
      }
    } catch (e) {
      ledgerError = e.message;
      console.error(`[strategy-board] rejection ledger unreadable (${e.message})`);
    }

    // ── the curated claims, so a measured verdict is not re-derived here ──
    let claims = [];
    try {
      claims = (evidenceRegister.getRegister() || {}).claims || [];
    } catch (e) {
      console.error(`[strategy-board] evidence register unreadable (${e.message})`);
    }

    const rows = KNOWN_SETUPS.map(name => {
      const l = live[name] || null;
      const s = shadowStats[name] || null;

      // The verdict rule is stated in the response rather than left implicit,
      // because a label like STRONG carries an implied sample size and this book
      // does not have one yet for anything.
      let verdict, basis;
      if (l && l.trades >= LIVE_JUDGEMENT_FLOOR) {
        const wr = l.wins / (l.wins + l.losses || 1) * 100;
        verdict = wr >= 65 ? "STRONG" : wr >= 55 ? "OK" : wr >= 45 ? "REVIEW" : "KILL";
        basis = `${l.trades} live fills, ${wr.toFixed(0)}% win rate`;
      } else if (l && l.trades > 0) {
        verdict = "LEARNING";
        basis = `${l.trades} live fill(s), under the ${LIVE_JUDGEMENT_FLOOR}-fill floor - no conclusion drawn`;
      } else if (s && s.enoughForReading) {
        verdict = "SHADOW ONLY";
        basis = `never filled live; ${s.episodes} forgone paper episodes at ${s.rPerEpisode}R each`;
      } else {
        verdict = "TOO FEW";
        basis = "no live fills and not enough forgone episodes to read";
      }

      return {
        setup: name,
        live: l ? {
          trades: l.trades, wins: l.wins, losses: l.losses,
          pnl: Math.round(l.pnl * 100) / 100,
          // R, not dollars. The same six fills read -223.91 in currency and +3.51R
          // in risk units, because one of them was sized 14x the others.
          realizedR: l.rTrades ? Math.round(l.realizedR * 1000) / 1000 : null,
          realizedRTrades: l.rTrades,
        } : null,
        shadow: s ? {
          episodes: s.episodes, wins: s.wins, losses: s.losses,
          netR: s.totalR, rPerEpisode: s.rPerEpisode,
          winRate: s.winRate, enoughForReading: s.enoughForReading,
          gates: s.gates || [], symbols: s.symbols || [],
        } : null,
        killedBy: killedBy[name] || {},
        verdict,
        basis,
      };
    });

    res.json({
      gate: strategySettings.confidenceThreshold,
      settingsError: strategySettingsError,
      liveJudgementFloor: LIVE_JUDGEMENT_FLOOR,
      totalLiveFills: rows.reduce((n, r) => n + (r.live ? r.live.trades : 0), 0),
      shadowAgeHours,
      shadowError,
      ledgerError,
      claims: claims.map(c => ({
        id: c.id, title: c.title, status: c.status,
        measuredOn: c.measuredOn, changesTheAnswer: c.changesTheAnswer,
      })),
      rows,
      verdictRule: `STRONG >=65% / OK >=55% / REVIEW >=45% / KILL <45%, but ONLY at ${LIVE_JUDGEMENT_FLOOR}+ live fills. `
                 + "Below that it is LEARNING and no conclusion is drawn. SHADOW ONLY means it has never "
                 + "filled live and the number beside it is forgone PAPER trades.",
      shadowCaveat: "Shadow rows are trades that were NEVER FILLED: no spread, no slippage, a fixed "
                  + "scoring horizon. They are a screening signal for which gate to investigate, not "
                  + "realised P&L, and where they contradict a walk-forward the walk-forward wins.",
      feedsTheGate: false,
    });
  } catch (e) {
    console.error("[strategy-board]", e.message);
    res.status(500).json({ error: e.message, rows: [] });
  }
});

// ── /api/robustness-report — the Monte-Carlo report behind /report ─────────
// Reads the file tasks/montecarlo_report.cjs writes. Does NOT run it: that harness
// replays three assets and bootstraps 4,000 paths, which is minutes of CPU on the box
// that trades. A page request must never start it.
app.get("/api/robustness-report", (_, res) => {
  const p = path.join(__dirname, "..", "tasks", "analysis", "montecarlo-latest.json");
  try {
    if (!fs.existsSync(p)) {
      return res.json({ status: "NOT RUN",
        detail: "No robustness report on this box yet.", feedsTheGate: false });
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const ms = Date.parse(raw.generatedAt || "");
    res.json({
      status: "OK",
      ageHours: Number.isFinite(ms) ? Math.round(((Date.now() - ms) / 3600000) * 10) / 10 : null,
      report: raw,
      feedsTheGate: false,
    });
  } catch (e) {
    // Unreadable is not absent. Say which, and never serve a half-parsed report.
    console.error("[robustness-report]", e.message);
    res.json({ status: "UNREADABLE", detail: e.message, feedsTheGate: false });
  }
});

// ── /api/measured-evidence — what has actually been MEASURED, on one screen ──
//
// Every harness in tasks/ writes a JSON report and, until now, every one of them was
// read by a human running a command. Findings that live only in a terminal are
// findings nobody acts on, and this project has already learned that lesson twice:
// /api/near-miss owned 24 of 24 blocks while rendered on ZERO pages, and lotStep was
// pushed, stored, and read by nothing.
//
// This reads the reports off disk and reports their AGE beside them. It runs no
// harness - a page request must never kick off an 18-replay walk-forward - so a
// report that has never been generated is reported as NOT RUN rather than silently
// blank. "Not measured" and "measured as zero" are different facts.
//
// Read-only, session-gated by the /api/ rule, feedsTheGate false.
app.get("/api/measured-evidence", (_, res) => {
  const dir = path.join(__dirname, "..", "tasks", "analysis");

  // Each entry: the file, what question it answers, and how to regenerate it. The
  // command is carried so a stale panel tells you how to refresh it instead of
  // leaving you to grep for the harness.
  const REPORTS = [
    { key: "ceilingWalkforward", file: "rsi-ceiling-walkforward-latest.json",
      title: "RSI ceiling — walk-forward, equal-count folds, costs charged",
      command: "node tasks/rsi_ceiling_walkforward.cjs" },
    { key: "ceilingWalkforwardTime", file: "rsi-ceiling-walkforward-time-latest.json",
      title: "RSI ceiling — walk-forward, equal-TIME folds",
      command: "RSI_CEILING_FOLD_MODE=time node tasks/rsi_ceiling_walkforward.cjs" },
    { key: "ceilingWalkforwardPerAsset", file: "rsi-ceiling-walkforward-latest-perasset.json",
      title: "RSI ceiling — walk-forward, per-asset cost basis",
      command: "RSI_CEILING_COST=perasset node tasks/rsi_ceiling_walkforward.cjs" },
    { key: "ceilingForward", file: "ceiling-measure-latest.json",
      title: "RSI ceiling — forward returns vs a matched control",
      command: "node tasks/ceiling_measure.cjs --json" },
    { key: "pbo", file: "pbo-latest.json",
      title: "Probability of backtest overfitting (CSCV)",
      command: "node tasks/pbo.cjs --json" },
    { key: "sizing", file: "sizing_walkforward.json",
      title: "Position sizing — fixed lot vs risk-based, in money",
      command: "node tasks/sizing_walkforward.cjs --json" },
  ];

  // ENGINE EPOCH. calcRSI was a simple 14-bar average, not Wilder, for this
  // system's whole life; it was corrected at this instant (commit b7d89a5). RSI
  // moved 6 to 13 points and the sign varied, so EVERY report generated before
  // this measured a different engine and its verdicts do not carry over.
  //
  // This is not hypothetical: the first version of this route counted a 68.9-hour
  // old per-asset cut as a completed cut and admitted 64/60 to the survivors list
  // on the strength of it, while the two FRESH cuts disagreed about that very
  // candidate. A stale report reading as current is the failure this project keeps
  // repeating - see the fill count that stayed in the boot file long after it
  // stopped being true.
  //
  // Move this forward whenever something changes what the engine computes.
  const ENGINE_EPOCH = Date.parse("2026-08-25T12:15:06Z");

  const out = {};
  for (const r of REPORTS) {
    const p = path.join(dir, r.file);
    const entry = { title: r.title, command: r.command, file: r.file };
    try {
      if (!fs.existsSync(p)) {
        entry.status = "NOT RUN";
        entry.detail = "no report on disk — this question has not been measured on this box";
        out[r.key] = entry;
        continue;
      }
      const stat = fs.statSync(p);
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      entry.status = "OK";
      // AGE, not just a timestamp. A timestamp makes the reader hold today's date and
      // do the subtraction, which is exactly what went wrong when the shadow ledger
      // served stale stats for a day and nobody noticed.
      const stampedAt = raw.generatedAt || raw.measuredAt || stat.mtime.toISOString();
      entry.generatedAt = stampedAt;
      const ms = Date.parse(stampedAt);
      entry.ageHours = Number.isFinite(ms)
        ? Math.round(((Date.now() - ms) / 3600000) * 10) / 10 : null;

      // A report older than the engine epoch is STALE, not merely old. It is
      // excluded from every verdict below rather than quietly averaged in.
      // An UNDATED report is treated as stale too: if it cannot prove it is
      // current, it does not get to vote.
      entry.stale = !Number.isFinite(ms) || ms < ENGINE_EPOCH;
      if (entry.stale) {
        entry.status = "STALE";
        entry.detail = "generated before the calcRSI correction (2026-08-25T12:15Z), "
                     + "so it measured a different engine - re-run before trusting it";
      }
      entry.report = raw;
    } catch (e) {
      // An unreadable report is NOT an absent one. Say which.
      entry.status = "UNREADABLE";
      entry.detail = e.message;
      console.error(`[measured-evidence] ${r.file}: ${e.message}`);
    }
    out[r.key] = entry;
  }

  // A compact ceiling summary the page can render without re-deriving anything. The
  // candidate rows already carry worstFold and foldsPositive; nothing is recomputed
  // here, because a second implementation of "which candidate wins" is a second thing
  // to drift from the harness that decided it.
  function ceilingRows(entry) {
    if (!entry || entry.status !== "OK") return null;
    const cands = entry.report.candidates || {};
    return Object.values(cands).map(c => ({
      label: c.label,
      worstFold: c.worstFold,
      foldsPositive: c.foldsPositive,
      foldsScored: c.foldsScored,
      closed: c.overall ? c.overall.closed : null,
      totalR: c.overall ? c.overall.R : null,
      isBaseline: !!c.isBaseline,
      beatsBaseline: !!c.beatsBaselineWorstFold,
    }));
  }

  // A challenger only counts if it beats the baseline under EVERY cut that has been
  // run. One cut is a coin toss with extra steps - candidates flip between 5/5 and
  // 3/5 purely on where the fold lines fall, which is what the equal-time cut caught.
  const cuts = ["ceilingWalkforward", "ceilingWalkforwardTime", "ceilingWalkforwardPerAsset"];
  // OK only. A STALE cut is not a cut that ran, it is a cut that ran against
  // different arithmetic.
  const cutsRun = cuts.filter(k => out[k] && out[k].status === "OK");
  const cutsStale = cuts.filter(k => out[k] && out[k].status === "STALE");
  const perCut = {};
  for (const k of cutsRun) perCut[k] = ceilingRows(out[k]);

  let survivors = null;
  if (cutsRun.length) {
    const names = new Set();
    for (const k of cutsRun) for (const row of perCut[k]) if (!row.isBaseline) names.add(row.label);
    survivors = [...names].filter(name =>
      cutsRun.every(k => {
        const row = perCut[k].find(r => r.label === name);
        return row && row.beatsBaseline;
      }));
  }

  res.json({
    reports: out,
    ceiling: {
      cutsRun: cutsRun.length,
      cutsTotal: cuts.length,
      perCut,
      survivorsAcrossEveryCutRun: survivors,
      standard: "A challenger must beat the baseline's WORST FOLD under every cut that "
              + "has been run. Winning one cut is a coin toss with extra steps.",
        cutsStale: cutsStale.length,
      incomplete: cutsRun.length < cuts.length
        ? (cuts.length - cutsRun.length) + " cut(s) not usable"
          + (cutsStale.length ? " (" + cutsStale.length + " STALE - predate the calcRSI fix)" : " (not yet run)")
          + " — this is not a verdict"
        : null,
    },
    note: "Reports are read off disk. Nothing here runs a harness, changes a setting, "
        + "or touches a position.",
    feedsTheGate: false,
  });
});

// ── /api/preopen-plan — the plan the 12:00 UTC job produced ─────────────────
//
// Serves the ARTIFACT, and deliberately does not build the plan on demand.
// tasks/preopen_plan.cjs makes seven HTTP calls back to this same server plus a
// login; running it inside a route would mean the dashboard's poll fires eight
// self-requests through the event loop it is already occupying. The plan is a
// point-in-time statement about the session ahead anyway — recomputing it on every
// dashboard refresh would produce a different "distance to fire" each poll and
// destroy the one property that makes a plan useful, which is that it does not move
// while you are reading it.
//
// AGE IS PART OF THE ANSWER. A plan from three days ago is not a plan, and the whole
// point of surfacing this is that a stale read must never look like a fresh one.
const PREOPEN_PLAN_STALE_MINUTES = 24 * 60;   // one trading day; the job runs daily
app.get("/api/preopen-plan", (_, res) => {
  const file = path.join(__dirname, "..", "tasks", "analysis", "preopen-plan-latest.json");
  try {
    if (!fs.existsSync(file)) {
      // Not an error: the job has simply never run on this box. Say which job, or the
      // reader has no way to act on it.
      return res.json({
        available: false,
        reason: "no plan artifact yet — runs daily at 12:00 UTC, or: node tasks/preopen_plan.cjs",
        feedsTheGate: false,
      });
    }
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    const ageMinutes = Math.round((Date.now() - Date.parse(plan.generatedAt)) / 60000);
    res.json({
      available: true,
      ageMinutes,
      stale: !Number.isFinite(ageMinutes) || ageMinutes > PREOPEN_PLAN_STALE_MINUTES,
      staleAfterMinutes: PREOPEN_PLAN_STALE_MINUTES,
      plan,
      feedsTheGate: false,
    });
  } catch (e) {
    console.error("[preopen-plan]", e.message);
    res.status(500).json({ available: false, error: e.message, feedsTheGate: false });
  }
});

// ── /api/deep-plan — the full document, as data ─────────────────────────────
//
// Same artifact-not-on-demand rule as /api/preopen-plan, and for a stronger reason: the
// deep plan makes eleven HTTP calls back to this server and sends a Telegram message.
// Rebuilding it on a dashboard poll would message the user every time someone opened a
// browser tab.
const DEEP_PLAN_STALE_MINUTES = 24 * 60;
app.get("/api/deep-plan", (_, res) => {
  const file = path.join(__dirname, "..", "tasks", "analysis", "deep-plan-latest.json");
  try {
    if (!fs.existsSync(file)) {
      return res.json({
        available: false,
        reason: "no deep plan yet — runs nightly after the close, or: node tasks/deep_plan.cjs",
        feedsTheGate: false,
      });
    }
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    const ageMinutes = Math.round((Date.now() - Date.parse(plan.generatedAt)) / 60000);
    res.json({
      available: true,
      ageMinutes,
      stale: !Number.isFinite(ageMinutes) || ageMinutes > DEEP_PLAN_STALE_MINUTES,
      staleAfterMinutes: DEEP_PLAN_STALE_MINUTES,
      plan,
      feedsTheGate: false,
    });
  } catch (e) {
    console.error("[deep-plan]", e.message);
    res.status(500).json({ available: false, error: e.message, feedsTheGate: false });
  }
});

// ── /api/size — Kelly-based position sizing ───────────────────
app.post("/api/size", (req, res) => {
  try {
    const { accountBalance, signal, openPositions } = req.body || {};
    if (!accountBalance || !signal) {
      return res.status(400).json({ error: "accountBalance and signal required" });
    }
    // Hand the risk engine the SAME gate the signal engine used. Without this it
    // applies its own hardcoded 65 and silently overrides confidenceThreshold —
    // the bridge fails closed on rejection, so every signal below 65 was approved
    // upstream and killed here with nothing on the dashboard to explain it.
    // Price per point comes from the broker via the bridge, never a constant. The
    // signal's symbol is the SmartEntry ticker; the spec is keyed by the MT5 symbol,
    // so accept either and fall back to the whole map for the open positions.
    const valuePerPointBySymbol = {};
    for (const [mt5Symbol, spec] of Object.entries(mt5SymbolSpecs)) {
      valuePerPointBySymbol[mt5Symbol] = spec.valuePerPoint;
    }
    for (const [assetKey, cached] of Object.entries(mt5CandleCache)) {
      const spec = cached?.symbol ? mt5SymbolSpecs[cached.symbol] : null;
      if (spec) valuePerPointBySymbol[assetKey.toUpperCase()] = spec.valuePerPoint;
    }

    const validation = sizing.validateTrade(signal, accountBalance, openPositions || [], {
      minConfidence: strategySettings.confidenceThreshold,
      valuePerPointBySymbol,
    });
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

// ABSENT and CORRUPT are different answers and must never share a return value.
//
// This used to `catch {}` and return an empty list for both. Every writer below calls
// this first, mutates the result and writes it back — so ONE unparseable read silently
// converted the whole file into a single row, with nothing in the log. Combined with a
// non-atomic write (which is what produces a truncated file in the first place) that is
// a closed loop: the bad write creates the corruption, the silent read turns it into a
// delete, and the next save makes it permanent. Fixing either alone leaves the loop
// open, so both are fixed here.
//
// Absent is still a normal first run and still returns the empty default. Corrupt
// throws, because refusing to answer is the only response that cannot destroy data.
function loadProposals() {
  if (!fs.existsSync(PROPOSALS_PATH)) return { proposals: [] };
  let raw;
  try {
    raw = fs.readFileSync(PROPOSALS_PATH, "utf8");
  } catch (e) {
    console.error(`[proposals] UNREADABLE ${PROPOSALS_PATH}: ${e.message} — refusing to ` +
                  `report an empty list, because the next save would make that permanent.`);
    throw e;
  }
  try {
    // Strip a UTF-8 BOM before parsing. readFileSync("utf8") keeps it, so a BOM'd but
    // otherwise perfect file would parse-fail and be reported as corruption. This repo
    // has been burned by exactly that input: PowerShell Set-Content -Encoding utf8
    // emits a BOM and silently reset the VPS to defaults on 2026-08-02.
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    if (!parsed || !Array.isArray(parsed.proposals)) {
      throw new Error("parsed but has no proposals array");
    }
    return parsed;
  } catch (e) {
    console.error(`[proposals] CORRUPT ${PROPOSALS_PATH}: ${e.message} — ${raw.length} bytes ` +
                  `on disk. NOT returning an empty list: every writer round-trips through ` +
                  `this function, so doing so would delete the file's contents on the next ` +
                  `save. Fix or move the file by hand.`);
    throw e;
  }
}
function saveProposals(data) {
  fs.mkdirSync(path.dirname(PROPOSALS_PATH), { recursive: true });
  // Atomic: temp + rename, the same guarantee saveLearning already uses. A plain
  // writeFileSync interrupted mid-flush leaves a truncated file, which is precisely
  // the input that used to read back as "empty".
  writeJsonAtomic(PROPOSALS_PATH, data);
}

// ── Peer heartbeat: so each box can notice the OTHER one dying ────────────────
//
// The VPS has an external watcher -- tasks/vps_monitor.ps1 runs on the laptop
// precisely so a powered-off VPS still raises an alarm. The laptop had none. If it
// sleeps, crashes or is simply shut, Bridge A on account 25446287 stops trading and
// nothing anywhere says so; the absence of trades looks exactly like a quiet market.
//
// The laptop cannot be reached from outside, so the direction has to be push: the
// laptop reports in, and the VPS -- which is always on and always reachable -- is the
// one that notices when it stops.
//
// Guarded by AGENT_RELAY_SECRET, the same shared secret /api/agent/notify already
// uses, because this endpoint is reachable from the internet on the VPS. It records a
// timestamp and a status string and touches nothing else: no signal, no position, no
// setting. The worst a caller with the secret can do is lie about being alive.
const peerHeartbeats = {};

/**
 * What the reporting box is RUNNING, not merely that it is running.
 *
 * The pull probe cannot work in this direction — the laptop is not addressable from
 * outside — so without this the always-on box knows its peer is alive and nothing
 * else: not its gate, not whether its breaker is open, not whether its bridges are
 * armed. That is the same single-box blindness the Systems Plan was built to end,
 * left standing in the one direction that could not be fixed by pulling.
 *
 * Whitelisted and bounded field by field. The caller is already authenticated by
 * AGENT_RELAY_SECRET and this is display-only — it feeds no gate, sizes nothing,
 * and arms nothing. Unknown keys are dropped rather than stored.
 */
function sanitizeHeartbeatState(state) {
  if (!state || typeof state !== "object") return null;
  const finiteOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const shortTags = (value) => (Array.isArray(value) ? value.slice(0, 8).map(tag => String(tag).slice(0, 16)) : []);
  return {
    gate:                finiteOrNull(state.gate),
    dailyPnl:            finiteOrNull(state.dailyPnl),
    unreviewedProposals: finiteOrNull(state.unreviewedProposals),
    halted:              state.halted === true,
    haltReason:          typeof state.haltReason === "string" ? state.haltReason.slice(0, 120) : "",
    settingsError:       typeof state.settingsError === "string" ? state.settingsError.slice(0, 120) : null,
    bridgesLive:         shortTags(state.bridgesLive),
    bridgesSilent:       shortTags(state.bridgesSilent),
    armed:               shortTags(state.armed),
  };
}

app.post("/api/peer-heartbeat", (req, res) => {
  const { secret, box, status, detail, state } = req.body || {};
  if (!AGENT_RELAY_SECRET || secret !== AGENT_RELAY_SECRET) {
    return res.status(403).json({ error: "invalid or missing secret" });
  }
  const name = typeof box === "string" && box.trim() ? box.trim().slice(0, 64) : "unknown";
  peerHeartbeats[name] = {
    box:    name,
    status: typeof status === "string" ? status.slice(0, 32) : "unknown",
    detail: typeof detail === "string" ? detail.slice(0, 300) : null,
    state:  sanitizeHeartbeatState(state),
    at:     new Date().toISOString(),
  };
  res.json({ ok: true, recorded: name, stateAccepted: peerHeartbeats[name].state !== null });
});

app.get("/api/peer-heartbeat", (_, res) => {
  const now = Date.now();
  res.json({
    peers: Object.values(peerHeartbeats).map(p => ({
      ...p,
      ageSeconds: Math.round((now - new Date(p.at).getTime()) / 1000),
    })),
  });
});

// Cloud research agent calls this to report findings and/or register a proposed change.
app.post("/api/agent/notify", (req, res) => {
  const { secret, message, proposal } = req.body || {};
  if (!AGENT_RELAY_SECRET || secret !== AGENT_RELAY_SECRET) {
    return res.status(403).json({ error: "invalid or missing secret" });
  }

  // Sent BEFORE the proposal is recorded, deliberately. A corrupt proposals file makes
  // the block below return 500, and the alert is the half that still works — losing it
  // too would mean a failure that is silent in the one channel a human actually reads.
  if (message && TELEGRAM_TOKEN) {
    const alertChatId = TELEGRAM_CHAT_ID || [...knownChatIds][0];
    if (alertChatId) sendTelegram(alertChatId, message).catch(() => {});
  }

  let id = null;
  if (proposal && typeof proposal === "object") {
    // A corrupt proposals file must fail this POST LOUDLY rather than append to an
    // empty object and wipe the record. The remote agent gets a 500 and can retry;
    // silently discarding everything already on file is not a recoverable state.
    try {
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
    } catch (e) {
      console.error("[agent/notify] proposal NOT recorded:", e.message);
      return res.status(500).json({
        ok: false,
        error: "proposals file unreadable — proposal not recorded, nothing was overwritten",
      });
    }
  }

  res.json({ ok: true, id });
});

// ── /api/memory — persistent JARVIS memory (read/write) ──────
// Same store memory.py (the CLI tool used by Claude Code sessions) reads and writes —
// this is what makes the web chat's memory genuinely cross-session, not just this tab.
const MEMORY_PATH = path.join(__dirname, "..", "tasks", "jarvis_memory.json");

// Same contract as loadProposals above, and for the same reason — see that comment.
// This one guards more: tasks/jarvis_memory.json is the web chat's cross-session
// memory and held 31 entries / 31,951 bytes when this was fixed. saveMemoryEntry
// round-trips through here, so a silent empty return followed by one save would have
// destroyed all 31 with nothing in the log to show for it.
function loadMemory() {
  if (!fs.existsSync(MEMORY_PATH)) return { version: 1, entries: [] };
  let raw;
  try {
    raw = fs.readFileSync(MEMORY_PATH, "utf8");
  } catch (e) {
    console.error(`[memory] UNREADABLE ${MEMORY_PATH}: ${e.message} — refusing to report ` +
                  `an empty store, because the next save would make that permanent.`);
    throw e;
  }
  try {
    // BOM stripped for the same reason as loadProposals above — a BOM'd file is
    // perfectly readable and must not be mistaken for a truncated one.
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new Error("parsed but has no entries array");
    }
    // Validate the ELEMENTS, not just the container. saveMemoryEntry does
    // e.key.toLowerCase() on every row, so one entry without a key throws a bare
    // TypeError deep in the writer instead of naming the file that is malformed.
    const bad = parsed.entries.findIndex(e => !e || typeof e.key !== "string");
    if (bad !== -1) throw new Error(`entry ${bad} has no string key`);
    return parsed;
  } catch (e) {
    console.error(`[memory] CORRUPT ${MEMORY_PATH}: ${e.message} — ${raw.length} bytes on ` +
                  `disk. NOT returning an empty store: saveMemoryEntry round-trips through ` +
                  `this function, so doing so would delete every saved fact on the next ` +
                  `write. Fix or move the file by hand.`);
    throw e;
  }
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
  // Atomic: temp + rename. A plain writeFileSync interrupted mid-flush leaves the
  // truncated file that loadMemory above now refuses to read as empty — this is the
  // other half of that loop, and closing only one end leaves the failure reachable.
  writeJsonAtomic(MEMORY_PATH, data);
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
  await queueSignalRefresh();
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
    getAiFilterHealth: () => aiFilterHealth,
    TELEGRAM_TOKEN,
    knownChatIds,
    refreshSignals,
    fetchPrices,
  });
  startPeerSilenceWatch();
  console.log('[BOOT] Auto-healer + SQLite DB active');
});
