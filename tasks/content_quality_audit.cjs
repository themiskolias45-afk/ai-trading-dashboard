/* ============================================================================
   CONTENT QUALITY AUDIT — the panel that renders perfectly and says nothing
   ============================================================================

   WHY THIS EXISTS

   tasks/page_quality_audit.cjs reads the MARKUP. It cannot tell a healthy panel
   from one whose data has been null since the third of the month, because both
   are the same HTML. That gap is not hypothetical here:

     - /daily-plan showed prices for every asset and every one of them was null,
       for twenty-six days, because a 401 nobody read was being parsed as a
       successful response.
     - The signals table had a reader and no writer and rendered empty.
     - The near-miss census reset at every server restart, so the panel was
       honest about a number that had been silently zeroed.

   In each case the page was FINE. The content was not. This audit reads what
   every dashboard page actually fetches, and reports the panels that are
   unreachable, empty, mostly-null, stale, or FROZEN — unchanged for days after
   a history of changing.

   HOW IT DECIDES WHAT TO PROBE

   The endpoint list is DERIVED from dashboard/*.html on every run, never
   hand-maintained. A hand-kept registry goes stale the first time somebody adds
   a panel, and a checker that silently stops covering something is the exact
   failure this file is about. Add a panel, it gets audited tomorrow.

   SAFETY — this reaches the RUNNING SERVER, so the rules are strict

     GET ONLY. Never a POST, PUT, PATCH or DELETE, on any route, for any reason.
     DENY LIST. GET is not automatically safe here: /api/backtest RUNS a 5-year
       backtest when its cache is over 12h old, /api/doctor SSHes to the peer,
       /api/congress and /api/youtube-search call third-party APIs, and /api/chat
       and /api/tts spend tokens. Everything on DENY is skipped and SAID to be
       skipped, with the reason — a silent skip is how coverage rots.
     NEVER BLOCKS. Always exits 0. A content finding must not fail a daily run.
     DELETES NOTHING. Writes two artifacts and appends to a history file.
     PROPOSES ONLY. It changes no page, no setting and no data.
     TOUCHES NO GATE. feedsTheGate is false and stays false.

   Usage: node tasks/content_quality_audit.cjs [--out <path>] [--json] [--quiet]
                                               [--selftest-only]
   ============================================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "dashboard");

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const OUT = opt("--out", path.join(ROOT, "dashboard", "content-quality.json"));
const HISTORY = opt("--history", path.join(ROOT, "dashboard", "content-quality-history.json"));
const QUIET = process.argv.includes("--quiet");
const AS_JSON = process.argv.includes("--json");
const SELFTEST_ONLY = process.argv.includes("--selftest-only");

const HTTP_TIMEOUT_MS = 8000;
const CONCURRENCY = 4;
/* Unchanged for this many DISTINCT days, having changed at least once before,
   is the frozen signal. Seven days rather than two because several of these
   panels legitimately sit still through a quiet week — this engine fills about
   once every four days. */
const FROZEN_DAYS = 7;
/* A payload carrying its own timestamp older than this is reported stale. Two
   days, not one, so a Monday morning does not light up over the weekend. */
const STALE_HOURS = 48;
/* Below this share of non-null top-level fields the panel is mostly holes. */
const MOSTLY_NULL_SHARE = 0.7;
/* History rows are appended forever; this only bounds what one run reads back
   into memory. Nothing is deleted from the file. */
const HISTORY_READ_LIMIT = 20000;

/* ── what must never be probed ───────────────────────────────────────────────
   Each entry names the route and WHY, because a deny list without reasons
   becomes a list nobody dares to shorten. Verified against server/index.js. */
const DENY = [
  ["/api/backtest",        "GET runs a 5-year backtest when its cache is >12h old"],
  ["/api/doctor",          "GET runs the fleet doctor, which SSHes to the peer"],
  ["/api/congress",        "GET calls the Unusual Whales API when its cache is empty"],
  ["/api/youtube-search",  "GET calls the YouTube API and requires a query"],
  ["/api/chat",            "spends Claude tokens"],
  ["/api/tts",             "spends tokens and synthesises audio"],
  ["/api/login",           "authentication endpoint"],
  ["/api/logout",          "would end this audit's own session"],
  ["/api/healer/heal",     "forces a heal — it ACTS"],
  ["/api/mt5/control",     "controls the bridge — it ACTS"],
  ["/api/engineer/status", "requires a run id in the path"],
  ["/api/scan",            "runs a scan"],
  ["/api/debate",          "spends tokens"],
];
/* Match on the PATH, never the raw string. The first version compared the whole
   endpoint including its query, so "/api/backtest?years=5" did not equal
   "/api/backtest" and the deny list let a FIVE-YEAR BACKTEST through. It ran.
   A deny list that a query string walks around is not a deny list. */
function denyReason(endpoint) {
  const routePath = String(endpoint).split("?")[0].replace(/\/+$/, "");
  const hit = DENY.find(d => routePath === d[0] || routePath.startsWith(d[0] + "/"));
  return hit ? hit[1] : null;
}

/* ── discover what the pages actually read ───────────────────────────────── */

/** Every /api/... path referenced by a dashboard page, with the pages that use it. */
function discoverEndpoints() {
  const byEndpoint = new Map();
  let files = [];
  try { files = fs.readdirSync(PAGES_DIR).filter(n => n.endsWith(".html")).sort(); }
  catch (e) { return { error: "could not read dashboard/: " + e.message, endpoints: [] }; }

  for (const name of files) {
    let src = "";
    try { src = fs.readFileSync(path.join(PAGES_DIR, name), "utf8"); } catch (e) { continue; }

    const found = new Set();
    /* The QUERY STRING is part of the endpoint. Dropping it made this audit call
       /api/mt5/health with no account, get the 503 that route correctly returns
       without one, and report a real page as broken — a false alarm about the
       audit's own request. architecture.html passes ?account=A and always did. */
    const PATH = "[a-zA-Z0-9._/-]+(?:\\?[a-zA-Z0-9._=&%+-]*)?";
    for (const m of src.matchAll(new RegExp("[\"'`](/api/" + PATH + ")", "g"))) found.add(m[1]);
    // getJson("/x") helpers prefix /api internally, so the literal lacks it.
    for (const m of src.matchAll(new RegExp("getJson\\(\\s*[\"'`](/" + PATH + ")", "g"))) {
      found.add(m[1].startsWith("/api/") ? m[1] : "/api" + m[1]);
    }

    const complete = new Set();
    const partial = new Set();
    for (let ep of found) {
      // Collapse the /api/api/ that the two rules above can produce together.
      while (ep.startsWith("/api/api/")) ep = ep.slice(4);
      ep = ep.replace(/\/+$/, "");
      if (ep === "/api" || ep.length < 6) continue;
      const q = ep.indexOf("?");
      if (q === -1) { complete.add(ep); continue; }
      /* A literal ending in "=" or "&" is a concatenation — `"/api/x?account=" + tag`.
         The value is not in the page, so probing it would test a request no page
         ever makes. Keep the base only as a fallback. */
      if (/[=&?]$/.test(ep)) partial.add(ep.slice(0, q));
      else complete.add(ep);
    }
    /* A base is only worth probing when no parameterised form of it was found. */
    const bases = new Set([...complete].map(e => e.split("?")[0]));
    for (const base of partial) if (!bases.has(base)) complete.add(base);

    for (const ep of complete) {
      if (!byEndpoint.has(ep)) byEndpoint.set(ep, new Set());
      byEndpoint.get(ep).add(name);
    }
  }

  /* Across pages: if any page names a parameterised form, drop the bare base —
     the same request, minus the parameter the route requires. */
  const parameterised = new Set([...byEndpoint.keys()].filter(e => e.includes("?"))
    .map(e => e.split("?")[0]));
  for (const ep of [...byEndpoint.keys()]) {
    if (!ep.includes("?") && parameterised.has(ep)) byEndpoint.delete(ep);
  }

  return {
    endpoints: [...byEndpoint.entries()]
      .map(([endpoint, pages]) => ({ endpoint, pages: [...pages].sort() }))
      .sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
  };
}

/* ── reading the server ──────────────────────────────────────────────────── */

function readEnv(key) {
  try {
    const line = fs.readFileSync(path.join(ROOT, "keys.env"), "utf8")
      .split(/\r?\n/).find(l => l.startsWith(key + "="));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch (e) { return null; }
}

/* Twenty-three of the forty-four panel endpoints are session-gated. An audit
   that can only see half the surface would report the visible half clean and
   say nothing about the rest — which is the blind spot, not a fix for it. Same
   service login tasks/deep_plan.cjs already uses. */
function login() {
  const username = readEnv("DASHBOARD_USERNAME");
  const password = readEnv("DASHBOARD_PASSWORD");
  if (!username || !password) {
    return Promise.resolve({ cookie: null, reason: "DASHBOARD_USERNAME/PASSWORD not in keys.env" });
  }
  const body = JSON.stringify({ username, password });
  return new Promise(resolve => {
    const req = http.request({
      host: "127.0.0.1", port: 3001, path: "/api/login", method: "POST",
      timeout: HTTP_TIMEOUT_MS,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      res.resume();
      const sc = res.headers["set-cookie"];
      if (res.statusCode === 200 && sc) {
        resolve({ cookie: sc.map(c => String(c).split(";")[0]).join("; "), reason: null });
      } else {
        resolve({ cookie: null, reason: "login returned HTTP " + res.statusCode });
      }
    });
    req.on("timeout", () => { req.destroy(); resolve({ cookie: null, reason: "login timed out" }); });
    req.on("error", e => resolve({ cookie: null, reason: e.code || e.message }));
    req.write(body); req.end();
  });
}

function getJson(pathname, cookie) {
  return new Promise(resolve => {
    const req = http.get({
      host: "127.0.0.1", port: 3001, path: pathname, timeout: HTTP_TIMEOUT_MS,
      headers: cookie ? { Cookie: cookie } : {},
    }, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
        try { resolve({ ok: true, data: JSON.parse(body), bytes: body.length }); }
        catch (e) { resolve({ ok: false, unparseable: true, bytes: body.length }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, timedOut: true }); });
    req.on("error", e => resolve({ ok: false, network: e.code || e.message }));
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/* ── judging a payload ───────────────────────────────────────────────────── */

/** Non-null leaf values anywhere in the payload. Zero means the panel has nothing to say. */
function substance(value, depth) {
  if (depth > 6) return 0;
  if (value === null || value === undefined || value === "") return 0;
  if (Array.isArray(value)) return value.reduce((n, v) => n + substance(v, depth + 1), 0);
  if (typeof value === "object") {
    return Object.values(value).reduce((n, v) => n + substance(v, depth + 1), 0);
  }
  return 1;
}

/** Top-level fields that carry nothing — the shape of "renders fine, says nothing". */
function emptyFields(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  return Object.keys(data).filter(k => {
    const v = data[k];
    if (v === null || v === undefined || v === "") return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
  });
}

/* A payload whose every collection is empty. /api/setup-health answers
   {"alerts":[],"updatedAt":...} — one value, and that value is a clock. The panel
   renders, the timestamp moves, and it has said nothing since it was built. On a
   quiet Saturday that is CORRECT, which is why this only becomes a finding after
   it has held for days. */
function isHollow(data) {
  if (!data || typeof data !== "object") return false;
  let collections = 0;
  let filled = 0;
  const walk = (v, depth) => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { collections++; if (v.length) { filled++; v.forEach(x => walk(x, depth + 1)); } return; }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(data, 0);
  return collections > 0 && filled === 0;
}

const TIME_FIELDS = ["generatedAt", "updatedAt", "lastUpdated", "asOf", "runAt", "at",
                     "timestamp", "computedAt", "builtAt", "startedAt"];

/** Age in hours from whatever timestamp the payload carries about itself. */
function selfReportedAgeHours(data) {
  if (!data || typeof data !== "object") return null;
  for (const field of TIME_FIELDS) {
    const raw = data[field];
    if (raw === null || raw === undefined || raw === "") continue;
    const ms = typeof raw === "number" ? raw : Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    const age = (Date.now() - ms) / 3600000;
    // A timestamp in the future or absurdly old is a broken clock, not an age.
    if (age < -1 || age > 24 * 3650) continue;
    return { field, ageHours: age };
  }
  return null;
}

/* A hash of the payload with its own timestamps removed, so a panel that only
   restamps itself every minute is still recognised as frozen. This is the whole
   point: /daily-plan restamped itself daily for twenty-six days while every
   price inside it stayed null. */
function contentHash(data) {
  const strip = (v, depth) => {
    if (depth > 6 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(x => strip(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (TIME_FIELDS.includes(k)) continue;
      if (/age(Hours|Ms|Seconds)?$/i.test(k)) continue;
      out[k] = strip(v[k], depth + 1);
    }
    return out;
  };
  try { return crypto.createHash("sha1").update(JSON.stringify(strip(data, 0))).digest("hex").slice(0, 16); }
  catch (e) { return null; }
}

/* ── append-only history ─────────────────────────────────────────────────── */

function readHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY, "utf8"));
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    return rows.slice(-HISTORY_READ_LIMIT);
  } catch (e) {
    // A missing history is the normal first run. A CORRUPT one must not be
    // overwritten silently — that is how a ledger loses its past. Say so, and
    // this run simply makes no frozen claims.
    if (e.code === "ENOENT") return [];
    return { corrupt: e.message };
  }
}

function appendHistory(existingRows, newRows) {
  try {
    fs.writeFileSync(HISTORY, JSON.stringify({
      note: "APPEND ONLY. One row per endpoint per run. Nothing here is ever deleted "
          + "or rewritten — the frozen-panel check needs the past to mean anything.",
      rows: existingRows.concat(newRows),
    }, null, 0));
    return null;
  } catch (e) { return e.message; }
}

/** Distinct days the endpoint has carried this exact hash, and whether it ever differed. */
function frozenFor(rows, endpoint, hash) {
  if (!hash) return null;
  const mine = rows.filter(r => r.e === endpoint);
  if (!mine.length) return null;
  const days = new Set();
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].h !== hash) break;
    days.add(String(mine[i].d).slice(0, 10));
  }
  const everDiffered = mine.some(r => r.h !== hash);
  return { days: days.size, everDiffered };
}

/* ── the checks ──────────────────────────────────────────────────────────── */

function classify(probe, history, endpoint) {
  if (probe.skipped) {
    return { level: "SKIPPED", detail: probe.skipped };
  }
  if (!probe.ok) {
    if (probe.timedOut) {
      return { level: "RED", check: "unreachable",
               detail: "no answer in " + Math.round(HTTP_TIMEOUT_MS / 1000) + "s" };
    }
    if (probe.network) {
      return { level: "RED", check: "unreachable", detail: "network " + probe.network };
    }
    if (probe.unparseable) {
      return { level: "RED", check: "unparseable",
               detail: "200 with a body that is not JSON — a login page or an error page "
                     + "parses cleanly as text and reads as healthy" };
    }
    if (probe.status === 401 || probe.status === 403) {
      return { level: "RED", check: "not-authorised",
               detail: "HTTP " + probe.status + " — this audit's own session did not reach it, "
                     + "so this panel is UNCHECKED, not clean" };
    }
    return { level: "RED", check: "http-error", detail: "HTTP " + probe.status };
  }

  const data = probe.data;
  const leaves = substance(data, 0);
  if (leaves === 0) {
    return { level: "RED", check: "empty",
             detail: "200 with no non-null value anywhere in the payload" };
  }

  const holes = emptyFields(data);
  const topLevel = data && typeof data === "object" && !Array.isArray(data)
    ? Object.keys(data).length : 0;
  if (topLevel >= 4 && holes.length / topLevel >= MOSTLY_NULL_SHARE) {
    return { level: "AMBER", check: "mostly-null",
             detail: holes.length + " of " + topLevel + " top-level fields are null or empty: "
                   + holes.slice(0, 6).join(", ") + (holes.length > 6 ? " …" : "") };
  }

  const age = selfReportedAgeHours(data);
  if (age && age.ageHours > STALE_HOURS) {
    return { level: "AMBER", check: "stale",
             detail: "its own " + age.field + " is " + Math.round(age.ageHours) + "h old" };
  }

  const frozen = Array.isArray(history) ? frozenFor(history, endpoint, probe.hash) : null;
  if (frozen && frozen.days >= FROZEN_DAYS) {
    if (frozen.everDiffered) {
      return { level: "AMBER", check: "frozen",
               detail: "byte-identical for " + frozen.days + " days (timestamps ignored) "
                     + "after a history of changing" };
    }
    /* Never differed AND every collection in it is empty. This is the panel that
       was wired up and never filled — the signals table that had a reader and no
       writer rendered exactly like this, and looked like a quiet market. */
    if (isHollow(data)) {
      return { level: "AMBER", check: "never-populated",
               detail: "every collection in it has been empty for " + frozen.days
                     + " days, and it has never held anything else" };
    }
  }

  return { level: "OK", check: null,
           detail: leaves + " value(s)" + (holes.length ? ", " + holes.length + " empty field(s)" : "") };
}

/* ── SELF-TEST ───────────────────────────────────────────────────────────────
   Canary payloads carrying one of each defect on purpose. A check that cannot
   fire reads exactly like a healthy panel — raw-interpolation in the page audit
   was dead from the day it was written and reported every page clean for its
   whole life. Never again without a canary. */
function selfTest() {
  const oldIso = new Date(Date.now() - 200 * 3600000).toISOString();
  const cases = [
    ["unreachable",    { skipped: null, ok: false, timedOut: true }, [], "/x"],
    ["not-authorised", { ok: false, status: 401 }, [], "/x"],
    ["unparseable",    { ok: false, unparseable: true }, [], "/x"],
    ["empty",          { ok: true, data: { a: null, b: "", c: [] }, hash: "h" }, [], "/x"],
    ["mostly-null",    { ok: true, data: { a: 1, b: null, c: null, d: null, e: "" }, hash: "h" }, [], "/x"],
    ["stale",          { ok: true, data: { generatedAt: oldIso, v: 1 }, hash: "h" }, [], "/x"],
    ["frozen",         { ok: true, data: { v: 1 }, hash: "same" },
                       [{ e: "/x", h: "other", d: "2026-08-01" }].concat(
                         Array.from({ length: FROZEN_DAYS }, (_, i) =>
                           ({ e: "/x", h: "same", d: "2026-08-1" + i }))), "/x"],
    // Wired up and never filled — no history of anything else, all collections empty.
    ["never-populated", { ok: true, data: { alerts: [], updatedAt: new Date().toISOString() },
                          hash: "same" },
                        Array.from({ length: FROZEN_DAYS }, (_, i) =>
                          ({ e: "/x", h: "same", d: "2026-08-1" + i })), "/x"],
  ];
  const fired = [];
  const dead = [];
  for (const [want, probe, history, endpoint] of cases) {
    let got = null;
    try { got = classify(probe, history, endpoint).check; } catch (e) { got = "threw: " + e.message; }
    (got === want ? fired : dead).push(want + (got === want ? "" : " (got " + got + ")"));
  }
  // And the discovery step: a checker that finds no endpoints reports everything clean.
  const found = discoverEndpoints().endpoints.length;
  if (found < 10) dead.push("discovery found only " + found + " endpoints");

  /* THE DENY LIST IS THE SAFETY BOUNDARY, so it is tested like one. The first
     version compared the whole endpoint string including its query, so
     "/api/backtest?years=5" slipped past "/api/backtest" and a FIVE-YEAR
     BACKTEST ran. Every denied route is re-checked here in each of the shapes a
     page can produce it. */
  const MUST_DENY = [
    "/api/backtest", "/api/backtest?years=5", "/api/backtest?years=10&force=1",
    "/api/doctor", "/api/doctor?x=1", "/api/congress", "/api/chat", "/api/tts",
    "/api/youtube-search?q=a", "/api/healer/heal", "/api/mt5/control",
    "/api/login", "/api/logout", "/api/engineer/status/abc123", "/api/backtest/",
  ];
  const leaked = MUST_DENY.filter(e => !denyReason(e));
  if (leaked.length) dead.push("DENY LIST LEAKS: " + leaked.join(", "));
  else fired.push("deny-list holds for " + MUST_DENY.length + " shapes");
  // And it must not over-block the panels the audit exists to read.
  const MUST_ALLOW = ["/api/signals", "/api/journal?limit=50", "/api/daily-plan",
                      "/api/mt5/health?account=A", "/api/learning"];
  const overBlocked = MUST_ALLOW.filter(e => denyReason(e));
  if (overBlocked.length) dead.push("DENY LIST OVER-BLOCKS: " + overBlocked.join(", "));

  return { allChecksFire: dead.length === 0, fired, dead, endpointsDiscovered: found };
}

/* ── run ─────────────────────────────────────────────────────────────────── */

async function audit() {
  const generatedAt = new Date().toISOString();
  const discovered = discoverEndpoints();
  if (discovered.error) {
    return { generatedAt, box: os.hostname(), available: false, reason: discovered.error,
             panels: [], feedsTheGate: false };
  }

  const session = await login();
  const historyRead = readHistory();
  const history = Array.isArray(historyRead) ? historyRead : [];
  const historyCorrupt = Array.isArray(historyRead) ? null : historyRead.corrupt;

  const probes = await mapLimit(discovered.endpoints, CONCURRENCY, async entry => {
    const reason = denyReason(entry.endpoint);
    if (reason) return { ...entry, skipped: reason };
    const res = await getJson(entry.endpoint, session.cookie);
    return { ...entry, ...res, hash: res.ok ? contentHash(res.data) : null };
  });

  const panels = probes.map(p => {
    const verdict = classify(p, history, p.endpoint);
    return {
      endpoint: p.endpoint,
      pages: p.pages,
      level: verdict.level,
      check: verdict.check || null,
      detail: verdict.detail,
      bytes: p.bytes ?? null,
      hash: p.hash || null,
    };
  });

  const day = generatedAt.slice(0, 10);
  const newRows = panels.filter(p => p.hash).map(p => ({ e: p.endpoint, h: p.hash, d: day }));
  const historyError = newRows.length ? appendHistory(history, newRows) : null;

  const findings = panels.filter(p => p.level === "RED" || p.level === "AMBER");
  return {
    generatedAt,
    box: os.hostname(),
    available: true,
    session: { authenticated: !!session.cookie, reason: session.reason },
    endpointsDiscovered: discovered.endpoints.length,
    probed: panels.filter(p => p.level !== "SKIPPED").length,
    skipped: panels.filter(p => p.level === "SKIPPED").length,
    red: panels.filter(p => p.level === "RED").length,
    amber: panels.filter(p => p.level === "AMBER").length,
    ok: panels.filter(p => p.level === "OK").length,
    totalFindings: findings.length,
    findings,
    panels,
    denyList: DENY.map(d => ({ endpoint: d[0], why: d[1] })),
    historyRows: history.length + newRows.length,
    historyCorrupt,
    historyError,
    note: "PROPOSES ONLY — GET requests to the running server and two JSON artifacts. "
        + "No page, setting, gate or record is written. Endpoints are DERIVED from "
        + "dashboard/*.html on every run, so a new panel is audited the next day.",
    feedsTheGate: false,
  };
}

(async () => {
  const test = selfTest();
  if (SELFTEST_ONLY) {
    if (!QUIET) {
      console.log("[content-quality] self-test: "
        + (test.allChecksFire ? "all " + test.fired.length + " checks fire" : "FAILED"));
      test.dead.forEach(d => console.log("    dead: " + d));
    }
    process.exit(0);
  }

  /* The deny list is the only thing standing between a daily job and a route that
     acts. If its own test fails, this run does NOT probe — it reports why and
     stops. Reporting a broken safety check while still using it is not a check.
     Still exit 0: refusing to probe must not fail the daily run either. */
  const denyBroken = test.dead.filter(d => d.startsWith("DENY LIST"));
  if (denyBroken.length) {
    const refusal = {
      generatedAt: new Date().toISOString(), box: os.hostname(), available: false,
      reason: "REFUSED TO PROBE — the deny-list self-test failed: " + denyBroken.join("; ")
            + ". No request was made to the server.",
      panels: [], selfTest: test, feedsTheGate: false,
    };
    try { fs.writeFileSync(OUT, JSON.stringify(refusal, null, 2)); } catch (e) { /* reported below */ }
    if (!QUIET) console.log("[content-quality] " + refusal.reason);
    process.exit(0);
  }

  let report;
  try { report = await audit(); }
  catch (e) {
    // An audit that dies must say so, not vanish and read as a quiet night.
    report = { generatedAt: new Date().toISOString(), box: os.hostname(), available: false,
               reason: "audit threw: " + e.message, panels: [], feedsTheGate: false };
  }
  report.selfTest = test;

  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); }
  catch (e) { if (!QUIET) console.error("[content-quality] could not write: " + e.message); }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!QUIET) {
    if (!report.available) {
      console.log("[content-quality] UNAVAILABLE — " + report.reason);
    } else {
      console.log("[content-quality] " + report.probed + " panel(s) probed, "
        + report.red + " red, " + report.amber + " amber, " + report.ok + " ok, "
        + report.skipped + " skipped"
        + (report.session.authenticated ? "" : "  [NOT LOGGED IN: " + report.session.reason + "]")
        + (test.allChecksFire ? ", all " + test.fired.length + " checks verified"
                              : ", SELF-TEST FAILED: " + test.dead.join("; ")));
      for (const f of report.findings) {
        console.log("      " + f.level + "  " + f.endpoint + "  [" + f.check + "]  " + f.detail);
        console.log("            read by: " + f.pages.join(", "));
      }
      if (report.historyCorrupt) {
        console.log("      history unreadable (" + report.historyCorrupt
          + ") — no frozen claims this run, and the file was NOT overwritten");
      }
    }
  }

  // ALWAYS 0. A content finding must never fail a daily run.
  process.exit(0);
})();
