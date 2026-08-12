// THE DEEP PLAN — the full trading document for the day ahead.
//
//   node tasks/deep_plan.cjs [--json] [--no-telegram] [--telegram]
//
// WHY THIS EXISTS
// There are roughly fifteen hours between the 21:00 daily close and the 13:00 NEW YORK
// open. Nothing used any of them. This builds the professional document in that gap:
// the day's clock with every blackout marked, a full entry plan per asset with levels,
// invalidation and the cohort each setup would land in, and the measured record behind
// every claim.
//
// IT BUILDS ON preopen_plan.cjs RATHER THAN BESIDE IT. Every shared figure — the gate,
// distance to fire, dead cohorts, blackout windows — comes from buildPlan() there. A
// second script re-deriving those is precisely how dashboard/index.html came to hardcode
// 65 while the live gate was 70 and every displayed gap was five points wrong.
//
// WHAT IT IS NOT
// Not a signal and not advice. It cannot open a trade, move a threshold or admit a
// setup: feedsTheGate is false and nothing here is read by the engine. Every number is
// read live or from a walk-forward artifact and is printed WITH the sample it rests on.
// Where the record is thin it says so rather than rounding a verdict out of two trades.
//
// DETERMINISTIC — no LLM, no tokens. The Claude weekly ceiling closed on 2026-08-12 and
// killed every agent job on the VPS at once. A plan that cannot be built on the day the
// ceiling closes is not a daily plan.

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const base = require("./preopen_plan.cjs");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = base.OUT_DIR;
const AS_JSON = process.argv.includes("--json");
const NO_TELEGRAM = process.argv.includes("--no-telegram");

const W = 92;
const HTTP_TIMEOUT_MS = 10000;

// How close to the open the plan wants to be built, and how far back it may walk when
// that moment is inside a news blackout. Named because both are judgement calls: an
// hour is long enough to read the document and short enough that the levels still hold,
// and three hours is the point past which "live" numbers stop deserving the word.
const PREOPEN_TARGET_MINUTES_BEFORE = 60;
const PREOPEN_EARLIEST_MINUTES_BEFORE = 180;
const PREOPEN_STEP_MINUTES = 15;

// Telegram hard-limits a message at 4096 characters. Splitting mid-tag breaks the HTML
// parse and the message is rejected whole, so the sender splits on blank lines only.
const TELEGRAM_LIMIT = 3900;

const NEW_YORK_OPEN_UTC_HOUR = 13;

// ── small helpers ───────────────────────────────────────────────────────────

const pad = (s, n) => String(s === null || s === undefined ? "" : s).padEnd(n);
const padL = (s, n) => String(s === null || s === undefined ? "" : s).padStart(n);
const hhmm = iso => String(iso).slice(11, 16);

function num(v, dp = 2) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(dp) : "—";
}

// A price of zero is ABSENCE, not a level. The engine returns null for stop and target
// when there is no setup, and Number(null) is 0 — which is finite, so a plain isFinite
// check printed "stop 0.00" and put a Stop rung 49x ATR below spot on the ladder. On a
// trading document that is not a cosmetic bug: it is a stop of zero rendered as a plan.
// None of these instruments can legitimately print at or below zero.
function isPrice(v) {
  return v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0;
}

function signed(v, dp = 3) {
  if (!Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return (n >= 0 ? "+" : "") + n.toFixed(dp);
}

function durationText(mins) {
  if (!Number.isFinite(mins)) return "unknown";
  if (mins < 0) return "open";
  if (mins < 60) return mins + "m";
  return Math.floor(mins / 60) + "h " + String(mins % 60).padStart(2, "0") + "m";
}

function rule(ch = "-") { return ch.repeat(W); }

function heading(title) {
  return ["", "  " + title.toUpperCase(), "  " + "-".repeat(Math.max(10, title.length))];
}

// ── the day's clock ─────────────────────────────────────────────────────────
//
// A timeline rather than a list, because the question a plan has to answer is not "what
// events exist" but "which hours can I actually trade". Blackout minutes are computed
// from the SAME window the news filter uses, so the document cannot claim protection the
// filter does not provide.
function buildDayClock(built) {
  const { raw, now } = built;
  const windowMins = (raw.calendar.data && raw.calendar.data.blackoutWindowMinutes) || 30;
  const events = (raw.calendar.data && raw.calendar.data.events) || [];

  // The window this plan covers: from now until the end of the NEW YORK session, which
  // is the last block that matters for the open being planned for.
  const from = new Date(now);
  const nyOpen = new Date(built.plan.nextNewYorkOpen);
  const until = new Date(nyOpen.getTime() + 4 * 3600 * 1000);   // NEW YORK is 13-17 UTC

  const blocks = base.SESSIONS.map(([name, fromH, toH]) => ({ name, fromH, toH }));

  const inWindow = events
    .filter(e => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t >= from.getTime() - windowMins * 60000 && t <= until.getTime();
    })
    .map(e => ({
      at: e.at, title: e.title, country: e.country, impact: e.impact,
      high: !!e.high, watched: !!e.watched,
      forecast: e.forecast || null, previous: e.previous || null,
      // Only a high-impact event in a market this system trades actually stops an entry.
      blocks: !!(e.high && e.watched),
      blocksFrom: new Date(Date.parse(e.at) - windowMins * 60000).toISOString(),
      blocksUntil: new Date(Date.parse(e.at) + windowMins * 60000).toISOString(),
      session: base.sessionAt(new Date(e.at)),
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const blackouts = inWindow.filter(e => e.blocks);

  // Does a blackout swallow the hour before the open? This is the question that made the
  // whole exercise necessary: the first pre-open job was scheduled at 12:00 UTC into a
  // PPI window that closed 12:00-13:00.
  const preOpenFrom = new Date(nyOpen.getTime() - PREOPEN_TARGET_MINUTES_BEFORE * 60000);
  const preOpenBlocked = blackouts.filter(b =>
    Date.parse(b.blocksUntil) > preOpenFrom.getTime() && Date.parse(b.blocksFrom) < nyOpen.getTime());

  return { windowMins, events: inWindow, blackouts, blocks, nyOpen, preOpenBlocked,
           unavailable: built.calendarUnavailable, error: raw.calendar.error || null };
}

// ── when should the pre-open plan actually run? ─────────────────────────────
//
// Walks BACKWARD from the target slot in fixed steps until it finds a moment that is not
// inside any blackout, floored so the plan never becomes a stale morning artifact. If
// every candidate is blocked it returns the floor and says so — it does not silently
// pick a blocked slot and it does not silently skip a day.
function computePreOpenSlot(clock) {
  const nyOpen = clock.nyOpen;
  const target = new Date(nyOpen.getTime() - PREOPEN_TARGET_MINUTES_BEFORE * 60000);
  const earliest = new Date(nyOpen.getTime() - PREOPEN_EARLIEST_MINUTES_BEFORE * 60000);

  const blocked = at => clock.blackouts.some(b =>
    at.getTime() >= Date.parse(b.blocksFrom) && at.getTime() <= Date.parse(b.blocksUntil));

  if (clock.unavailable) {
    // The calendar could not be read. Keep the target rather than inventing a shift, and
    // label it: a slot chosen from no information must not look like a chosen slot.
    return { at: target.toISOString(), minutesBeforeOpen: PREOPEN_TARGET_MINUTES_BEFORE,
             shifted: false, reason: "calendar unavailable — kept the default slot", confident: false };
  }

  if (!blocked(target)) {
    return { at: target.toISOString(), minutesBeforeOpen: PREOPEN_TARGET_MINUTES_BEFORE,
             shifted: false, reason: "the hour before the open is clear", confident: true };
  }

  for (let t = target.getTime() - PREOPEN_STEP_MINUTES * 60000;
       t >= earliest.getTime();
       t -= PREOPEN_STEP_MINUTES * 60000) {
    const candidate = new Date(t);
    if (!blocked(candidate)) {
      const mins = Math.round((nyOpen - candidate) / 60000);
      const who = clock.blackouts.map(b => b.title).slice(0, 2).join(", ");
      return { at: candidate.toISOString(), minutesBeforeOpen: mins, shifted: true,
               reason: `moved earlier: ${who} blacks out the hour before the open`, confident: true };
    }
  }

  return { at: earliest.toISOString(), minutesBeforeOpen: PREOPEN_EARLIEST_MINUTES_BEFORE,
           shifted: true, confident: false,
           reason: "every slot from 3h before the open is inside a blackout — using the earliest" };
}

// ── the level ladder ────────────────────────────────────────────────────────
//
// Every level the engine already computes, on one axis, sorted by price with the
// distance from spot in both points and ATR multiples. ATR matters more than points: a
// $40 gap is close on Gold and enormous on SPX, and a ladder in raw points invites
// exactly that error.
function buildLadder(asset) {
  const price = Number(asset.price);
  const atr = Number(asset.atr);
  if (!Number.isFinite(price)) return [];

  const ind = asset.indicators || {};
  const bb = ind.bb || {};
  const piv = asset.pivots || {};
  const st = asset.structure || {};

  const candidates = [
    ["R2 pivot", piv.r2], ["R1 pivot", piv.r1], ["Pivot", piv.pp],
    ["S1 pivot", piv.s1], ["S2 pivot", piv.s2],
    ["BB upper", bb.upper], ["BB middle", bb.middle], ["BB lower", bb.lower],
    ["EMA20", ind.ema20], ["EMA50", ind.ema50], ["EMA200", ind.ema200],
    ["Swing high", st.swingHigh], ["Swing low", st.swingLow],
    ["Entry", asset.entry], ["Stop", asset.stop], ["Target", asset.target],
  ];

  const seen = new Set();
  return candidates
    .filter(([, v]) => isPrice(v))
    .map(([name, v]) => {
      const level = Number(v);
      const distance = level - price;
      return {
        name, level, distance,
        atrMultiple: Number.isFinite(atr) && atr > 0 ? distance / atr : null,
        side: Math.abs(distance) < 1e-9 ? "at" : distance > 0 ? "above" : "below",
      };
    })
    // Two indicators landing on the same price is noise, not confluence at this
    // resolution; keep the first name and drop the duplicate.
    .filter(l => { const k = l.level.toFixed(4); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.level - a.level);
}

// ── which cohorts could this setup land in ──────────────────────────────────
//
// Returns CANDIDATES, never a single asserted cohort. The first version matched by name
// and confidently reported "BTC H4-only, NONE — DEAD" for a setup whose timeframe was
// D1. That is worse than saying nothing: it tells you a live setup is structurally dead
// when it is not, and this document's whole claim is that it never states more than it
// knows.
//
// The cohort rules live in server/cohort_table.js and are NOT re-implemented here — a
// second copy is how index.html came to hardcode 65 against a gate of 70. What this does
// is narrow the published table to the rows consistent with the legs currently printing,
// and show them all with their statuses. Narrowing is safe; asserting is not.
function relevantCohorts(asset, cohortRows) {
  if (!Array.isArray(cohortRows) || !cohortRows.length) return { available: false };

  const d1 = String(asset.signal || "WAIT").toUpperCase();
  const h4 = String((asset.h4 && asset.h4.signal) || "WAIT").toUpperCase();

  // No setup on either leg means there is nothing to place in a cohort. Saying "no
  // setup" is the honest answer; picking a row anyway is how the bug above happened.
  if (d1 === "WAIT" && h4 === "WAIT") {
    return { available: true, pattern: null, rows: [],
             note: "no setup on D1 or H4 — there is nothing to place in a cohort yet" };
  }

  const pattern = d1 === "WAIT" ? "H4-ONLY"
                : h4 === "WAIT" ? "DAILY-NEUTRAL-H4"
                : h4 === d1 ? "DAILY+H4 AGREE"
                : "DAILY FIRES, H4 DISAGREES";

  const label = String(asset.label || "").toUpperCase();
  const assetWord = label.includes("BITCOIN") || label.includes("BTC") ? "BTC"
                  : label.includes("GOLD") || label.includes("XAU") ? "GOLD"
                  : label.includes("S&P") || label.includes("SPX") ? "SPX" : null;

  const rows = cohortRows.filter(r => {
    const n = String(r.name || "").toUpperCase();
    // A row naming a different asset cannot apply. A row naming none applies to all.
    if (/\b(BTC|GOLD|SPX)\b/.test(n) && assetWord && !n.includes(assetWord)) return false;
    if (n.includes("NON-GOLD") && assetWord === "GOLD") return false;
    return n.includes(pattern);
  });

  return { available: true, pattern, rows: rows.map(r => ({
    name: r.name, base: r.base, ceiling: r.ceiling, status: r.status,
    short: r.short, effectiveGate: r.effectiveGate })) };
}

// ── what happened since the last plan ───────────────────────────────────────
//
// A document that only ever looks forward is never wrong, because nothing it says is
// ever checked. This reads the PREVIOUS plan artifact and scores it against what the
// market actually did: which of the levels it named were crossed, whether the gap to
// the gate narrowed or widened, and what fired.
//
// It is a review, not a verdict. Crossing a level is not a prediction coming true — the
// ladder names levels, it does not forecast them — but "R1 was taken out overnight" is
// the single most useful sentence a morning plan can open with, and until now nothing
// anywhere produced it.
function reviewSincePrevious(previous, assets, journal) {
  if (!previous || !previous.generatedAt) return null;

  const sincePlan = Date.parse(previous.generatedAt);
  if (!Number.isFinite(sincePlan)) return null;
  const hoursAgo = (Date.now() - sincePlan) / 3600000;

  const perAsset = assets.map(now => {
    const before = (previous.assets || []).find(a => a.key === now.key);
    if (!before || now.unavailable || before.unavailable) {
      return { key: now.key, label: now.label, unavailable: true };
    }
    const from = Number(before.price), to = Number(now.price);
    const moved = isPrice(from) && isPrice(to) ? to - from : null;

    // A level counts as CROSSED when it sits between the two prices. Using the previous
    // plan's ladder, not today's: the question is what the last document told you to
    // watch, and today's ladder has already moved with the price.
    const crossed = !isPrice(from) || !isPrice(to) ? [] :
      (before.ladder || [])
        .filter(l => isPrice(l.level))
        .filter(l => (l.level > Math.min(from, to) && l.level < Math.max(from, to)))
        .map(l => ({ name: l.name, level: l.level, direction: to > from ? "up through" : "down through" }));

    return {
      key: now.key, label: now.label,
      priceFrom: from, priceTo: to, moved,
      movedAtr: moved !== null && Number.isFinite(Number(now.atr)) && Number(now.atr) > 0
        ? moved / Number(now.atr) : null,
      confidenceFrom: before.confidence, confidenceTo: now.confidence,
      gapFrom: before.gap, gapTo: now.gap,
      // Named plainly. "gap narrowed" is the only forward-looking thing in this section
      // and it is a fact about two readings, not a forecast.
      gapDirection: !Number.isFinite(before.gap) || !Number.isFinite(now.gap) ? null
        : now.gap < before.gap ? "narrowed" : now.gap > before.gap ? "widened" : "unchanged",
      crossed,
      trendFrom: before.trend, trendTo: now.trend,
      trendFlipped: before.trend !== now.trend,
    };
  });

  // Anything that actually traded in the window. This is the part that would matter most
  // and almost always reads zero: one closed fill in this system's whole life.
  const trades = (Array.isArray(journal) ? journal : []).filter(t => {
    const t0 = Date.parse(t.openedAt || t.timestamp || t.date || "");
    return Number.isFinite(t0) && t0 >= sincePlan;
  });

  // Blackouts the previous plan warned about that have now passed.
  const passed = ((previous.clock && previous.clock.blackouts) || [])
    .filter(b => Date.parse(b.blocksUntil) < Date.now())
    .map(b => ({ title: b.title, country: b.country, at: b.at }));

  return { previousAt: previous.generatedAt, hoursAgo, perAsset, trades, blackoutsPassed: passed,
           previousSlot: previous.preOpenSlot ? previous.preOpenSlot.at : null };
}

// ── what the record says about this setup ───────────────────────────────────
function setupRecord(asset, learning) {
  const setup = asset.setup;
  if (!setup || setup === "WAIT" || !learning) return null;
  const live = (learning.setupStats || {})[setup] || null;
  const shadowStats = (learning.shadow && learning.shadow.stats) || {};
  const shadow = shadowStats[setup] || null;
  return { setup, live, shadow };
}

// ── read the extra endpoints the deep plan needs ────────────────────────────
function getJson(pathname, cookie) {
  return new Promise(resolve => {
    const req = http.get({ host: "localhost", port: 3001, path: pathname,
      timeout: HTTP_TIMEOUT_MS, headers: cookie ? { Cookie: cookie } : {} }, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ error: `HTTP ${res.statusCode}` });
        try { resolve({ data: JSON.parse(body) }); } catch (e) { resolve({ error: "unparseable" }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.on("error", e => resolve({ error: e.message }));
  });
}

function readEnv(key) {
  try {
    const line = fs.readFileSync(path.join(ROOT, "keys.env"), "utf8")
      .split(/\r?\n/).find(l => l.startsWith(key + "="));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch (e) { return null; }
}

// ── Telegram ────────────────────────────────────────────────────────────────
//
// Sent through the Bot API directly rather than through the server, because this script
// must still deliver when the server is the thing that is down — which is precisely the
// morning you most want the message.
function telegramSend(text) {
  const token = readEnv("TELEGRAM_TOKEN");
  const chatId = readEnv("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return Promise.resolve({ sent: false, reason: "TELEGRAM_TOKEN or TELEGRAM_CHAT_ID not set" });

  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
  const https = require("https");
  return new Promise(resolve => {
    const req = https.request({
      host: "api.telegram.org", path: `/bot${token}/sendMessage`, method: "POST",
      timeout: HTTP_TIMEOUT_MS,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let out = "";
      res.on("data", c => (out += c));
      res.on("end", () => {
        if (res.statusCode === 200) return resolve({ sent: true });
        // Telegram rejects the whole message on a bad tag, so the reason matters.
        resolve({ sent: false, reason: `HTTP ${res.statusCode}: ${out.slice(0, 160)}` });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ sent: false, reason: "timeout" }); });
    req.on("error", e => resolve({ sent: false, reason: e.message }));
    req.write(body);
    req.end();
  });
}

// Splits on blank lines only. Splitting mid-tag makes Telegram reject the message
// entirely rather than render it imperfectly.
function splitForTelegram(text) {
  const parts = [];
  let current = "";
  for (const para of text.split("\n\n")) {
    if ((current + "\n\n" + para).length > TELEGRAM_LIMIT && current) {
      parts.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) parts.push(current);
  return parts;
}

const esc = s => String(s === null || s === undefined ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── build the whole document ────────────────────────────────────────────────
async function buildDeep() {
  // Read the PREVIOUS plan before anything in this run overwrites it. Once
  // writeArtifacts runs, deep-plan-latest.json is this plan and the comparison is gone.
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "deep-plan-latest.json"), "utf8")); }
  catch (e) { previous = null; }

  const built = await base.buildPlan();          // gate, distance to fire, cohorts, blackouts
  const cookie = await (async () => {
    // buildPlan already logged in; re-login here only to get a cookie this module can
    // use for the extra endpoints. Cheap, and avoids reaching into the other module's
    // private state.
    const username = readEnv("DASHBOARD_USERNAME");
    const password = readEnv("DASHBOARD_PASSWORD");
    if (!username || !password) return null;
    const body = JSON.stringify({ username, password });
    return new Promise(resolve => {
      const req = http.request({ host: "localhost", port: 3001, path: "/api/login", method: "POST",
        timeout: HTTP_TIMEOUT_MS,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, res => {
        res.resume();
        const sc = res.headers["set-cookie"];
        resolve(res.statusCode === 200 && sc ? sc.map(c => String(c).split(";")[0]).join("; ") : null);
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.write(body); req.end();
    });
  })();

  const [learning, gateHealth, rejection, measurements, journal] = await Promise.all([
    getJson("/api/learning", cookie), getJson("/api/gate-health", cookie),
    getJson("/api/rejection-evidence", cookie), getJson("/api/measurements", cookie),
    getJson("/api/journal?limit=50", cookie),
  ]);

  const clock = buildDayClock(built);
  const slot = computePreOpenSlot(clock);
  const cohortRows = built.cohortsUnavailable ? [] : (built.raw.cohorts.data.rows || []);
  const settings = built.raw.settings.data;
  const signalsRaw = built.raw.signals.data || {};

  const assets = ["btc", "gold", "spx"].map(key => {
    const s = signalsRaw[key];
    const summary = built.plan.assets.find(a => a.key === key) || { key, unavailable: true };
    if (!s) return { ...summary, unavailable: true };
    return {
      ...summary,
      price: s.price, atr: s.atr, trend: s.trend, regime: s.regime, strength: s.strength,
      setupTimeframe: s.setupTimeframe,
      entry: s.entry, stop: s.stop, target: s.target, rr: s.rr,
      indicators: s.indicators || {}, volume: s.volume || {}, structure: s.structure || {},
      reasons: s.reasons || [],
      h4: s.h4 || null, h1: s.h1 || null,
      ladder: buildLadder(s),
      cohorts: relevantCohorts(s, cohortRows),
      record: setupRecord(s, learning.data),
      // The stop distance in ATR is the single most useful sizing sanity check available
      // without contract size, which this script deliberately does not assume — assuming
      // 1.0 once made Gold 74x oversize.
      hasTrade: isPrice(s.stop) && isPrice(s.target) && isPrice(s.entry),
      stopAtr: isPrice(s.stop) && isPrice(s.entry) && Number.isFinite(Number(s.atr)) && Number(s.atr) > 0
        ? Math.abs(Number(s.entry) - Number(s.stop)) / Number(s.atr) : null,
    };
  });

  const sessionRanking = (() => {
    const hm = built.heatmap && built.heatmap.atLiveGate && built.heatmap.atLiveGate.session;
    const wf = built.sessionWf && built.sessionWf.atLiveGate && built.sessionWf.atLiveGate.slices;
    if (!hm) return null;
    return Object.entries(hm).map(([name, v]) => {
      const fold = Array.isArray(wf) ? wf.find(x => x.slice === name) : null;
      return { session: name, closed: v.closed, winRatePct: +v.wr.toFixed(1), rPerTrade: +v.rpt.toFixed(3),
               removingImproves: fold ? `${fold.foldsImproved}/${fold.foldsScored}` : null,
               verdict: fold ? fold.verdict : null };
    }).sort((a, b) => b.rPerTrade - a.rPerTrade);
  })();

  const doc = {
    kind: "deep-plan",
    generatedAt: built.now.toISOString(),
    box: os.hostname(),
    gate: built.gate,
    settingsError: settings.settingsError || null,
    currentSession: built.plan.currentSession,
    newYorkOpen: built.plan.nextNewYorkOpen,
    minutesToNewYork: built.plan.minutesToNewYork,
    preOpenSlot: slot,
    since: reviewSincePrevious(previous, assets,
      (journal.data && (journal.data.trades || journal.data.entries || journal.data)) || []),
    clock: { windowMinutes: clock.windowMins, unavailable: clock.unavailable, error: clock.error,
             events: clock.events, blackouts: clock.blackouts,
             preOpenBlockedBy: clock.preOpenBlocked.map(b => b.title) },
    assets,
    sessionRanking,
    sessionEvidence: built.plan.sessionEvidence,
    risk: built.plan.risk,
    limits: { maxConcurrentPositions: settings.maxConcurrentPositions,
              maxTradesPerDay: settings.maxTradesPerDay,
              fixedLotSize: settings.fixedLotSize, minStrength: settings.minStrength,
              adxTrendingMin: settings.adxTrendingMin, minEntryRsi: settings.minEntryRsi },
    openPositions: built.plan.openPositions,
    unprotectedPositions: built.plan.unprotectedPositions,
    deadCohorts: built.plan.deadCohorts,
    deadCohortNames: built.plan.deadCohortNames,
    cohortsUnavailable: built.cohortsUnavailable,
    calendarUnavailable: built.calendarUnavailable,
    learning: learning.data ? { setupStats: learning.data.setupStats || {},
                                shadow: (learning.data.shadow && learning.data.shadow.stats) || {},
                                unattributed: learning.data.unattributed || null } : null,
    gateHealth: gateHealth.data ? gateHealth.data.gates : null,
    rejectionEvidence: rejection.data && rejection.data.available ? rejection.data : null,
    measurementsAge: measurements.data && measurements.data.measurements
      ? Object.entries(measurements.data.measurements).map(([k, v]) => ({ id: k, ageHours: v.ageHours, available: v.available }))
      : null,
    unavailable: [
      ["learning", learning.error], ["gate-health", gateHealth.error],
      ["rejection-evidence", rejection.error], ["measurements", measurements.error],
      ["calendar", built.raw.calendar.error], ["cohort-reachability", built.raw.cohorts.error],
    ].filter(x => x[1]).map(x => x[0] + ": " + x[1]),
    feedsTheGate: false,
  };

  return { doc, built };
}

// ── render the console document ─────────────────────────────────────────────
function renderDeep(doc) {
  const L = [];
  const push = (...xs) => xs.forEach(x => L.push(x));

  push(rule("="));
  push(`  DEEP TRADING PLAN — ${doc.generatedAt.replace("T", " ").slice(0, 16)} UTC   [${doc.box}]`);
  push(`  now in ${doc.currentSession} · NEW YORK opens ${hhmm(doc.newYorkOpen)} UTC `
     + `(${durationText(doc.minutesToNewYork)}) · live gate ${doc.gate}`
     + (doc.settingsError ? "  *** settingsError — running on DEFAULTS ***" : ""));
  push(rule("="));

  // ---- anything that voids the rest goes first ----
  if (doc.risk && doc.risk.halted) {
    push("", `  ** TRADING HALTED — ${doc.risk.haltReason || "circuit breaker"}. Nothing below can fire. **`);
  }
  if (doc.unprotectedPositions > 0) {
    push("", `  ** ${doc.unprotectedPositions} OPEN POSITION(S) WITH NO BROKER-SIDE STOP — deal with this first. **`);
  }
  if (doc.unavailable.length) {
    push("", `  ** ${doc.unavailable.length} SOURCE(S) UNREADABLE: ${doc.unavailable.join("; ")}`,
             `     Sections below that depend on them say so; none of them is reported as zero. **`);
  }

  // ---- 0. what happened since the last plan ----
  //
  // First, because it is the only section that can tell you the previous document was
  // wrong. A plan that only looks forward is never checked and therefore never improves.
  if (doc.since) {
    push(...heading("Since the last plan"));
    push(`    Previous plan built ${doc.since.previousAt.replace("T", " ").slice(0, 16)} UTC`
      + `, ${doc.since.hoursAgo.toFixed(1)}h ago.`);
    push("");
    for (const a of doc.since.perAsset) {
      if (a.unavailable) { push(`    ${pad(a.label || a.key, 14)} not comparable`); continue; }
      const dir = a.moved === null ? "" : a.moved >= 0 ? "up" : "down";
      push(`    ${pad(a.label, 14)}${num(a.priceFrom)} -> ${num(a.priceTo)}`
        + (a.moved === null ? "" : `  ${dir} ${num(Math.abs(a.moved))}`
            + (a.movedAtr === null ? "" : ` (${num(Math.abs(a.movedAtr), 2)}x ATR)`)));
      if (a.gapDirection && a.gapDirection !== "unchanged") {
        push(`                  gap to gate ${a.gapDirection}: ${a.gapFrom}pt -> ${a.gapTo}pt`);
      }
      if (a.trendFlipped) {
        push(`                  ** TREND FLIPPED: ${a.trendFrom} -> ${a.trendTo} — anything the last`);
        push(`                     plan said about ${a.label} was written under the old regime. **`);
      }
      for (const c of a.crossed.slice(0, 6)) {
        push(`                  crossed ${c.direction} ${c.name} at ${num(c.level)}`);
      }
      if (!a.crossed.length && a.moved !== null) {
        push(`                  no level from the last ladder was crossed`);
      }
    }
    push("");
    if (doc.since.trades.length) {
      push(`    ${doc.since.trades.length} trade(s) since that plan:`);
      for (const t of doc.since.trades.slice(0, 8)) {
        push(`      ${pad(t.symbol || t.asset || "?", 10)} ${pad(t.direction || t.type || "", 6)}`
          + ` ${t.status || (t.closedAt ? "closed" : "open")}`
          + (t.pnl !== undefined ? `  P&L ${num(t.pnl)}` : ""));
      }
    } else {
      push("    Nothing traded in that window.");
    }
    if (doc.since.blackoutsPassed.length) {
      push(`    ${doc.since.blackoutsPassed.length} blackout(s) the last plan flagged have now passed: `
        + doc.since.blackoutsPassed.map(b => b.title).slice(0, 4).join(", "));
    }
    push("");
    push("    A crossed level is not a forecast coming true — the ladder names levels, it does");
    push("    not predict them. This section exists so the previous document can be checked.");
  }

  // ---- 1. the day's clock ----
  push(...heading("1. The trading day ahead"));
  if (doc.clock.unavailable) {
    push(`    ** CALENDAR UNAVAILABLE (${doc.clock.error}) — this plan CANNOT say which hours are blocked.`,
         `       That is not the same as "no events today". **`);
  } else if (!doc.clock.events.length) {
    push("    No calendar events between now and the close of NEW YORK.");
  } else {
    push(`    Blackout window: ${doc.clock.windowMinutes} min either side of a high-impact event`,
         `    in a market this system trades. Only those stop an entry.`, "");
    push("    " + pad("TIME", 8) + pad("SESSION", 13) + pad("MKT", 5) + pad("IMPACT", 9) + "EVENT");
    for (const e of doc.clock.events.slice(0, 24)) {
      push("    " + pad(hhmm(e.at), 8) + pad(e.session, 13) + pad(e.country, 5)
        + pad(e.impact, 9) + e.title
        + (e.blocks ? `   << BLOCKS ${hhmm(e.blocksFrom)}-${hhmm(e.blocksUntil)}` : ""));
    }
    if (doc.clock.blackouts.length) {
      push("", `    ${doc.clock.blackouts.length} blackout window(s) ahead:`);
      for (const b of doc.clock.blackouts) {
        push(`      ${hhmm(b.blocksFrom)}-${hhmm(b.blocksUntil)} UTC  ${b.country} ${b.title}`
          + (b.session === "NEW YORK" ? "   (inside NEW YORK)" : ""));
      }
    } else {
      push("", "    No blackout windows ahead — nothing on the calendar will stop an entry.");
    }
  }

  push("", `    Pre-open plan slot: ${hhmm(doc.preOpenSlot.at)} UTC `
    + `(${doc.preOpenSlot.minutesBeforeOpen}min before the open) — ${doc.preOpenSlot.reason}`);
  if (!doc.preOpenSlot.confident) {
    push(`    ** that slot was NOT chosen from a clean calendar read — treat the timing as provisional. **`);
  }

  // ---- 2. risk state ----
  push(...heading("2. Risk state — what the account allows today"));
  if (!doc.risk) {
    push("    Risk state unreadable.");
  } else {
    push(`    Circuit breaker : ${doc.risk.consecutiveLosses}/3 consecutive losses`
      + (doc.risk.halted ? "  HALTED" : "  armed"));
    push(`    Daily P&L       : ${doc.risk.dailyPnl}`);
    push(`    Open positions  : ${doc.openPositions} of ${doc.limits.maxConcurrentPositions} allowed`
      + (doc.unprotectedPositions ? `  (${doc.unprotectedPositions} UNPROTECTED)` : "  (all with broker-side stops)"));
    push(`    Sizing          : ${doc.limits.fixedLotSize > 0
      ? `FIXED ${doc.limits.fixedLotSize} lots — risk-based sizing is OFF, so stop distance does not change size`
      : "risk-based"}`);
    push(`    Trade budget    : up to ${doc.limits.maxTradesPerDay}/day`);
    push(`    Entry filters   : minStrength ${doc.limits.minStrength}, adxTrendingMin ${doc.limits.adxTrendingMin}`
      + `, minEntryRsi ${doc.limits.minEntryRsi}${doc.limits.minEntryRsi === 0 ? " (disarmed)" : ""}`);
  }

  // ---- 3. per asset ----
  push(...heading("3. The entry plan, asset by asset"));
  for (const a of doc.assets) {
    push("", "  " + rule("~").slice(2));
    if (a.unavailable) { push(`  ${a.key.toUpperCase()} — signal unavailable`); continue; }

    push(`  ${a.label}   ${num(a.price)}   ${a.trend} · ${a.regime} · ATR ${num(a.atr)}`);
    push(`  ${a.ready ? "READY TO FIRE" : `${a.gap}pt short of the gate`}`
      + `   confidence ${a.confidence}/${doc.gate}   setup ${a.setup || "none"} (${a.setupTimeframe || "?"}, ${a.strength || "NONE"})`);

    // alignment
    const i = a.indicators || {};
    push("");
    push(`    ALIGNMENT   D1 ${pad(a.legs.d1, 6)} RSI ${padL(num(i.rsi, 1), 5)}   ${a.trend}`);
    if (a.h4) push(`                4H ${pad(a.h4.signal, 6)} RSI ${padL(num(a.h4.rsi, 1), 5)}   ${a.h4.trend || ""}`);
    if (a.h1) push(`                1H ${pad(a.h1.signal, 6)} RSI ${padL(num(a.h1.rsi, 1), 5)}   ${a.h1.trend || ""}`);
    push(`                ADX ${num(i.adx, 1)} (+DI ${num(i.plusDI, 1)} / -DI ${num(i.minusDI, 1)})`
      + `   MACD hist ${signed(i.macd && i.macd.histogram, 2)}`
      + `   BB width ${num(i.bb && i.bb.bandwidth, 1)}%`);
    if (a.volume && Number.isFinite(Number(a.volume.ratio))) {
      push(`                Volume ${num(a.volume.ratio, 2)}x average`
        + (a.volume.confirmed ? " (confirmed)" : " (not confirming)"));
    }

    // the trade
    push("");
    if (a.ready && a.hasTrade) {
      push(`    THE TRADE   ${a.signal} entry ${num(a.entry)}  stop ${num(a.stop)}  target ${num(a.target)}`
        + `  R:R 1:${num(a.rr, 2)}`);
      push(`                stop is ${num(Math.abs(a.entry - a.stop))} away = ${num(a.stopAtr, 2)}x ATR`
        + `, size ${doc.limits.fixedLotSize} lots (fixed)`);
    } else if (a.hasTrade) {
      push(`    IF IT FIRES ${a.signal} entry ${num(a.entry)}  stop ${num(a.stop)}  target ${num(a.target)}`
        + `  R:R 1:${num(a.rr, 2)}`);
      push(`                — levels are live but confidence is ${a.confidence}, ${a.gap}pt under the gate.`);
    } else {
      push(`    NO TRADE    no stop or target computed — the engine has no setup here, so there is`);
      push(`                no entry to plan. What it is waiting for:`);
      for (const r of (a.reasons || []).slice(0, 4)) push(`                  · ${r}`);
    }

    // the ladder
    if (a.ladder && a.ladder.length) {
      push("");
      push("    LEVELS      " + pad("LEVEL", 14) + pad("PRICE", 12) + pad("DISTANCE", 12) + "xATR");
      for (const l of a.ladder) {
        const marker = l.side === "above" ? "^" : l.side === "below" ? "v" : "=";
        push("                " + pad(l.name, 14) + padL(num(l.level), 11) + " "
          + padL(signed(l.distance, 2), 11) + " "
          + padL(l.atrMultiple === null ? "—" : signed(l.atrMultiple, 2), 7) + "  " + marker);
      }
      push(`                spot ${num(a.price)} — ^ above, v below`);
    }

    // cohort
    push("");
    const co = a.cohorts;
    if (!co || !co.available) {
      push("    COHORTS     reachability table unavailable — cannot say whether this setup could fire.");
    } else if (co.note) {
      push(`    COHORTS     ${co.note}.`);
    } else if (!co.rows.length) {
      push(`    COHORTS     legs read ${co.pattern}, but no published cohort row matches that`);
      push(`                pattern for this asset. Not guessing — check /api/cohort-reachability.`);
    } else {
      push(`    COHORTS     legs read ${co.pattern} — candidate rows from the published table:`);
      for (const r of co.rows) {
        const dead = r.status === "DEAD" || r.status === "BLOCKED (MEASURED)";
        push(`                ${pad(r.name, 40)} base ${padL(r.base, 2)} ceiling ${padL(r.ceiling, 2)}`
          + `  ${r.status}${dead ? `  (${r.short}pt short)` : ""}`);
      }
      if (co.rows.every(r => r.status === "DEAD" || r.status === "BLOCKED (MEASURED)")) {
        push(`                ** every candidate cohort is unreachable — a setup on these legs`);
        push(`                   could not fire however good it was. **`);
      }
      push(`                Narrowed from the published table by leg pattern; the cohort rules`);
      push(`                themselves live in server/cohort_table.js and are not re-derived here.`);
    }

    // the record
    if (a.record && (a.record.live || a.record.shadow)) {
      push("");
      push(`    THE RECORD  ${a.record.setup}`);
      if (a.record.live) {
        const r = a.record.live;
        push(`                live: ${r.total} trade(s), ${num(r.winRate, 0)}% win, P&L ${num(r.totalPnl)}`
          + `, status ${r.status}`);
        if (r.total < 5) push(`                      too few to judge — this is a sample of ${r.total}.`);
      }
      if (a.record.shadow) {
        const s = a.record.shadow;
        push(`                shadow: ${JSON.stringify(s).slice(0, 70)}`);
        push(`                      paper episodes from gate rejections. No spread, no slippage,`);
        push(`                      never filled. A screen, not a jury.`);
      }
    }

    // invalidation
    push("");
    push("    INVALIDATION");
    if (a.ready && Number.isFinite(Number(a.stop))) {
      push(`                price through ${num(a.stop)} — the plan is wrong, take the stop.`);
    } else {
      push(`                this plan assumes ${a.trend} on D1 and ${a.regime}. A flip on either`);
      push(`                voids everything above for ${a.label}; re-read before acting on it.`);
    }
  }

  // ---- 4. when to trade ----
  push(...heading("4. When to trade — the measured record by session"));
  if (!doc.sessionRanking) {
    push("    No heat map on this box — run: node tasks/time_heatmap.cjs");
  } else {
    push("    " + pad("SESSION", 14) + padL("TRADES", 7) + padL("WIN%", 7) + padL("R/TRADE", 9)
      + "   REMOVING IT IMPROVES");
    for (const s of doc.sessionRanking) {
      push("    " + pad(s.session, 14) + padL(s.closed, 7) + padL(num(s.winRatePct, 1), 7)
        + padL(signed(s.rPerTrade), 9) + "   " + (s.removingImproves || "—")
        + (s.verdict ? "  " + s.verdict : ""));
    }
    // Derived, never asserted. A hardcoded "NEW YORK is the only positive session" sat
    // directly above a table showing PRE-LONDON at +1.399 — prose contradicting the data
    // printed three lines above it is exactly the drift this document exists to avoid.
    push("");
    const positives = doc.sessionRanking.filter(s => s.rPerTrade > 0);
    const stable = positives.filter(s => s.verdict === "CONSISTENTLY NEGATIVE");   // negative to REMOVE = good to keep
    if (positives.length) {
      push("    Positive at the gate: " + positives.map(s =>
        `${s.session} (${signed(s.rPerTrade)}R on ${s.closed})`).join(", ") + ".");
    }
    if (stable.length) {
      push("    Of those, " + stable.map(s => s.session).join(" and ")
        + " also survives the fold test — removing it improves");
      push("    " + stable.map(s => `${s.removingImproves} folds`).join(" / ")
        + ", so the gain is not one lucky window. That is the session this plan is built for.");
    }
    const unstable = positives.filter(s => s.verdict && s.verdict !== "CONSISTENTLY NEGATIVE");
    for (const s of unstable) {
      push(`    ${s.session} looks better at ${signed(s.rPerTrade)}R but on only ${s.closed} trades and`);
      push(`    ${s.removingImproves} folds — ${s.verdict}. Not something to trade on yet.`);
    }
    const shown = new Set(doc.sessionRanking.map(s => s.session));
    const missing = base.SESSIONS.map(s => s[0]).filter(n => !shown.has(n));
    if (missing.length) {
      push(`    ${missing.join(", ")} not shown — below the minimum closed trades per cell.`);
    }
    push("    Read these as fold deltas on out-of-sample replay, not realised P&L. Nothing");
    push("    filters by session in live trading: no hour is blocked, this is context only.");
  }

  // ---- 5. structural limits ----
  push(...heading("5. Structural limits"));
  if (doc.cohortsUnavailable) {
    push("    ** COHORT REACHABILITY UNAVAILABLE — cannot say which cohorts are dead. **");
  } else {
    push(`    ${doc.deadCohorts} of 15 cohorts cannot reach gate ${doc.gate} at maximum boost:`);
    for (const n of doc.deadCohortNames || []) push(`      · ${n}`);
    push("    Dead does not imply wrongly dead — SPX H4-only is floored deliberately after");
    push("    measuring negative out-of-sample.");
  }

  push(...heading("How to read this"));
  push("  Every figure is read live or from a walk-forward artifact and carries the sample it");
  push("  rests on. Nothing here is a signal or an instruction: this document cannot open a");
  push("  trade, move a threshold or admit a setup, and the engine does not read it.");
  push("  Where a source could not be read it says UNAVAILABLE — never zero, never silence.");
  push(rule("="));
  return L.join("\n") + "\n";
}

// ── render the Telegram message ─────────────────────────────────────────────
//
// Deliberately not the console document with tags added. On a phone the useful subset is
// smaller: what is blocked, how far each asset is, and anything that voids the day.
function renderTelegram(doc) {
  const P = [];
  P.push(`<b>DEEP PLAN — ${doc.generatedAt.slice(0, 10)}</b>  [${esc(doc.box)}]\n`
    + `NY opens ${hhmm(doc.newYorkOpen)} UTC (${durationText(doc.minutesToNewYork)}) · gate ${doc.gate}`);

  const alarms = [];
  if (doc.settingsError) alarms.push("⚠️ running on DEFAULT settings — " + esc(doc.settingsError));
  if (doc.risk && doc.risk.halted) alarms.push("🛑 TRADING HALTED — " + esc(doc.risk.haltReason || "breaker"));
  if (doc.unprotectedPositions > 0) alarms.push(`🛑 ${doc.unprotectedPositions} position(s) with NO stop`);
  if (doc.unavailable.length) alarms.push("⚠️ unreadable: " + esc(doc.unavailable.join("; ")));
  if (alarms.length) P.push(alarms.join("\n"));

  // Overnight first on the phone too — what moved is the thing you want before the
  // forward-looking part, and only the entries that actually say something go in.
  if (doc.since) {
    const notable = doc.since.perAsset.filter(a => !a.unavailable
      && (a.trendFlipped || (a.crossed && a.crossed.length) || a.gapDirection === "narrowed"));
    if (notable.length || doc.since.trades.length) {
      const bits = notable.map(a => {
        const parts = [];
        if (a.trendFlipped) parts.push(`trend ${esc(a.trendFrom)} → ${esc(a.trendTo)}`);
        if (a.crossed && a.crossed.length) parts.push(`crossed ${a.crossed.map(c => esc(c.name)).join(", ")}`);
        if (a.gapDirection === "narrowed") parts.push(`gap ${a.gapFrom}→${a.gapTo}pt`);
        return `• <b>${esc(a.label)}</b> ${parts.join(" · ")}`;
      });
      if (doc.since.trades.length) bits.push(`• ${doc.since.trades.length} trade(s) since`);
      P.push(`<b>Since the last plan</b> (${doc.since.hoursAgo.toFixed(1)}h)\n` + bits.join("\n"));
    }
  }

  const lines = doc.assets.map(a => {
    if (a.unavailable) return `• <b>${esc(a.key.toUpperCase())}</b> — unavailable`;
    const head = a.ready
      ? `🟢 <b>${esc(a.label)} ${esc(a.signal)}</b> entry ${num(a.entry)} stop ${num(a.stop)} target ${num(a.target)} (R:R 1:${num(a.rr, 2)})`
      : `• <b>${esc(a.label)}</b> ${a.confidence}% — ${a.gap}pt short`;
    const legs = `\n   D1 ${esc(a.legs.d1)} · 4H ${esc(a.legs.h4)} · 1H ${esc(a.legs.h1)} · ${esc(a.trend)}`;
    // Only shout when EVERY candidate cohort is unreachable. One dead row among live ones
    // is not a blocked setup, and a warning that fires on the wrong condition trains you
    // to skim past the one that matters.
    const co = a.cohorts;
    const allDead = co && co.available && co.rows && co.rows.length
      && co.rows.every(r => r.status === "DEAD" || r.status === "BLOCKED (MEASURED)");
    const coh = allDead
      ? `\n   ⚠️ every candidate cohort (${esc(co.pattern)}) is unreachable at gate ${doc.gate}` : "";
    return head + legs + coh;
  });
  P.push("<b>Distance to fire</b>\n" + lines.join("\n"));

  if (doc.clock.unavailable) {
    P.push("<b>Blackouts</b>\n⚠️ calendar unreadable — this plan cannot say what is blocked. "
      + "That is not the same as nothing being blocked.");
  } else if (!doc.clock.blackouts.length) {
    P.push("<b>Blackouts</b>\nNone ahead — nothing on the calendar will stop an entry.");
  } else {
    P.push("<b>Blackouts</b>\n" + doc.clock.blackouts.map(b =>
      `${hhmm(b.blocksFrom)}-${hhmm(b.blocksUntil)} UTC ${esc(b.country)} ${esc(b.title)}`
      + (b.session === "NEW YORK" ? " <i>(inside NY)</i>" : "")).join("\n"));
  }

  if (doc.preOpenSlot.shifted || !doc.preOpenSlot.confident) {
    P.push(`<b>Pre-open slot</b>\n${hhmm(doc.preOpenSlot.at)} UTC — ${esc(doc.preOpenSlot.reason)}`);
  }

  // P&amp;L, not P&L: parse_mode=HTML rejects the whole message on a bare ampersand, and a
  // rejected message is indistinguishable from a plan that was never built.
  P.push(`<b>Risk</b>\nBreaker ${doc.risk ? doc.risk.consecutiveLosses : "?"}/3 · `
    + `P&amp;L ${doc.risk ? doc.risk.dailyPnl : "?"} · positions ${doc.openPositions}/${doc.limits.maxConcurrentPositions} · `
    + `${doc.limits.fixedLotSize > 0 ? "fixed " + doc.limits.fixedLotSize + " lots" : "risk-based"}`);

  if (doc.sessionRanking && doc.sessionRanking.length) {
    const ny = doc.sessionRanking.find(s => s.session === "NEW YORK");
    if (ny) P.push(`<b>The session ahead</b>\nNEW YORK: ${ny.closed} trades, ${num(ny.winRatePct, 1)}% win, `
      + `${signed(ny.rPerTrade)}R/trade${ny.removingImproves ? `, removing it improves ${ny.removingImproves} folds` : ""}. `
      + `<i>Out-of-sample replay, not realised P&amp;L — and nothing filters by session in live trading.</i>`);
  }

  P.push(`<i>Deterministic plan. Cannot open a trade, move a threshold or admit a setup.</i>`);
  return P.join("\n\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const { doc, built } = await buildDeep();

    // Keep the dashboard's Pre-Open Plan panel fresh from the same pass. Without this
    // the deep run would leave /api/preopen-plan reading an older artifact and the panel
    // would disagree with the document built seconds earlier.
    base.writeArtifacts(built);

    if (AS_JSON) {
      console.log(JSON.stringify(doc, null, 2));
    } else {
      const text = renderDeep(doc);
      fs.appendFileSync(path.join(ROOT, "tasks", "logs", "deep_plan.txt"), text + "\n");
      process.stdout.write(text);
    }

    const stamp = doc.generatedAt.replace(/[-:]/g, "").slice(0, 15);
    fs.writeFileSync(path.join(OUT_DIR, `deep-plan-${stamp}.json`), JSON.stringify(doc, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "deep-plan-latest.json"), JSON.stringify(doc, null, 2));

    if (!NO_TELEGRAM) {
      const parts = splitForTelegram(renderTelegram(doc));
      for (let i = 0; i < parts.length; i++) {
        const r = await telegramSend(parts.length > 1 ? `${parts[i]}\n\n<i>(${i + 1}/${parts.length})</i>` : parts[i]);
        // Reported, never thrown: a plan that was built and written is still a success
        // if the phone did not get it, and the console said so.
        console.error(r.sent ? `telegram: sent ${i + 1}/${parts.length}` : `telegram: NOT sent — ${r.reason}`);
        if (!r.sent) break;
      }
    }
  })().catch(e => {
    console.error("deep-plan: " + e.message);
    process.exit(2);
  });
}

module.exports = {
  buildDeep, renderDeep, renderTelegram,
  buildDayClock, computePreOpenSlot, buildLadder, relevantCohorts, setupRecord, isPrice,
  reviewSincePrevious,
  telegramSend, splitForTelegram,
  PREOPEN_TARGET_MINUTES_BEFORE, PREOPEN_EARLIEST_MINUTES_BEFORE, NEW_YORK_OPEN_UTC_HOUR,
};
