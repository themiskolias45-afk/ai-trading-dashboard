// FEEDS AND BACKUPS — one screen, every source of data this system runs on.
//
// WHY IT EXISTS. He asked "where is visible to see is feeding data" and the honest answer
// was: nowhere. Each feed could be checked, but only one at a time and each by a different
// command - /api/mt5/candles for bars, /api/mt5/health?account=A for the bridge,
// /api/atomic for the indicator, bucket_audit.cjs for the archives. Four commands and a
// remembered account tag is not a surface, and a feed nobody looks at is a feed that can
// die quietly. This puts all of them on one page with their ages.
//
// AGE IS THE WHOLE POINT. Every row states how old its data is, because "present" and
// "current" are different claims and this fleet has been bitten by the gap between them
// repeatedly - a four-day-old ticket under a live header, a backup that logged success
// while capturing 105 of 13,700 files, an EA watch that said UNKNOWN for four days.
//
// BACKUPS ARE NOT RE-IMPLEMENTED HERE. tasks/bucket_audit.cjs already opens the archives
// and checks the required files inside them; this runs it and shows its verdict. Two
// copies of that logic would drift, and the drifting copy is always the one being read.
//
// READ-ONLY. It performs GETs and reads files. It changes nothing.
//
//   node tasks/feeds_status.cjs           full screen
//   node tasks/feeds_status.cjs --feeds   feeds only, skip the archive open (faster)

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FEEDS_ONLY = process.argv.includes("--feeds");
const HOST = "127.0.0.1", PORT = 3001;

function get(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: p, method: "GET", timeout: 6000 }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", (e) => resolve({ status: 0, json: null, raw: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: null, raw: "timeout" }); });
    req.end();
  });
}

const pad = (s, n) => String(s).padEnd(n);
function age(ms) {
  if (ms === null || ms === undefined || !isFinite(ms)) return "unknown";
  const m = ms / 60000;
  if (m < 1) return Math.round(ms / 1000) + "s";
  if (m < 90) return m.toFixed(1) + "m";
  const h = m / 60;
  if (h < 48) return h.toFixed(1) + "h";
  return (h / 24).toFixed(1) + "d";
}
function mark(ok) { return ok === null ? "  ?  " : (ok ? " ok  " : " ***"); }

function line(label, value, ok, detail) {
  console.log("  " + mark(ok) + " " + pad(label, 26) + pad(value, 22) + (detail || ""));
}

(async () => {
  console.log("");
  console.log("================ FEEDS AND BACKUPS — " + os.hostname() + " ================");

  // ── 1. the server itself ──────────────────────────────────────────────────
  console.log("");
  console.log("  SERVER");
  const st = await get("/api/status");
  if (st.status !== 200 || !st.json) {
    line("localhost:3001", "OFFLINE", false, st.raw.slice(0, 60));
    console.log("");
    console.log("  Everything below reads through this server. Start it before trusting any row.");
    process.exit(0);
  }
  const upMs = st.json.startedAt ? Date.now() - new Date(st.json.startedAt).getTime() : null;
  line("localhost:3001", "up " + age(upMs), true, "started " + (st.json.startedAt || "?"));

  // ── 2. MT5 bars ───────────────────────────────────────────────────────────
  console.log("");
  console.log("  MT5 CANDLE FEED   (the bars the engine computes on)");
  const c = await get("/api/mt5/candles");
  const sources = (c.json && c.json.sources) || {};
  if (!Object.keys(sources).length) {
    line("candle cache", "EMPTY", false, "the bridge has not pushed since the last server restart");
  } else {
    for (const [k, v] of Object.entries(sources)) {
      const bars = v.bars || {};
      line(k + " (" + (v.brokerSymbol || "?") + ")",
           (v.inUse ? "inUse " : "IDLE  ") + age(v.ageMs),
           v.inUse === true && v.ageMs < 15 * 60000,
           "d1 " + (bars.d1 ?? "?") + "  h4 " + (bars.h4 ?? "?") + "  h1 " + (bars.h1 ?? "?"));
    }
  }

  // ── 3. the bridge, PER ACCOUNT TAG ────────────────────────────────────────
  // Queried per tag on purpose. /api/mt5/health with no ?account= looks up "default",
  // which no bridge ever reports under, so it answers "never connected" on a perfectly
  // healthy box. That exact mistake was made on 2026-09-08 and read as an outage.
  console.log("");
  console.log("  MT5 BRIDGE        (per account tag — the no-tag call always says 'never connected')");
  for (const tag of ["A", "B"]) {
    const h = await get("/api/mt5/health?account=" + tag);
    const j = h.json || {};
    if (j.connected === true)       line("account " + tag, "connected " + age(j.ageMs), true, "last seen " + (j.lastSeen || "?"));
    else if (j.expected === false)  line("account " + tag, "not on this box", null, (j.reason || "").slice(0, 70));
    else                            line("account " + tag, "NOT CONNECTED", false, (j.reason || "").slice(0, 70));
  }

  // ── 4. signals ────────────────────────────────────────────────────────────
  console.log("");
  console.log("  SIGNAL ENGINE");
  const s = await get("/api/signals");
  if (s.status === 200 && s.json) {
    const updMs = s.json.updatedAt ? Date.now() - new Date(s.json.updatedAt).getTime() : null;
    line("recomputed", age(updMs), updMs !== null && updMs < 45 * 60000, s.json.updatedAt || "");
    for (const k of ["btc", "gold", "spx"]) {
      const a = s.json[k];
      if (!a) continue;
      line("  " + k, (a.signal || "?") + " / " + (a.confidence ?? "?"), null,
           "src " + pad(a.dataSource || "?", 6) + " trend " + pad(a.trend || "?", 16) +
           " confirmed=" + a.trendConfirmed);
    }
  } else line("/api/signals", "HTTP " + s.status, false, s.raw.slice(0, 60));

  // ── 5. the ATOMIC indicator ───────────────────────────────────────────────
  console.log("");
  console.log("  ATOMIC ANALYST V84   (indicator — evidence only, gates nothing)");
  const feedDirs = [];
  try {
    const base = path.join(os.homedir(), "AppData", "Roaming", "MetaQuotes", "Terminal");
    for (const e of fs.readdirSync(base)) {
      const d = path.join(base, e, "MQL5", "Files", "atomic_analyst");
      try { if (fs.statSync(d).isDirectory()) feedDirs.push({ terminal: e, dir: d }); } catch {}
    }
  } catch {}
  if (!feedDirs.length) {
    line("indicator", "NOT ATTACHED", null, "no atomic_analyst folder in any terminal");
  } else {
    for (const t of feedDirs) {
      let files = [];
      try { files = fs.readdirSync(t.dir).filter((f) => f.endsWith(".json")); } catch {}
      for (const f of files) {
        let rec = null;
        try { rec = JSON.parse(fs.readFileSync(path.join(t.dir, f), "utf8")); } catch {}
        if (!rec) { line(f + " (file)", "UNREADABLE", false, ""); continue; }
        const aMs = Number.isFinite(rec.generatedAtEpoch) ? Date.now() - rec.generatedAtEpoch * 1000 : null;
        line(rec.symbol + " (file)", age(aMs), aMs !== null && aMs < 30 * 60000,
             pad(rec.verdict || "?", 20) + "conf " + (rec.confidence ?? "?") +
             "  acct " + (rec.account || "?") + "  term " + t.terminal.slice(0, 8));
      }
    }
  }
  const at = await get("/api/atomic");
  if (at.status === 401)      line("/api/atomic (server)", "session required", null, "log in to read it; the feed still works");
  else if (at.status === 200 && at.json) {
    line("/api/atomic (server)", at.json.count + " stored", at.json.count > 0,
         "feedsTheGate=" + at.json.feedsTheGate);
    for (const v of at.json.verdicts || [])
      line("  " + v.symbol, age(v.ageMinutes * 60000), !v.stale,
           pad(v.verdict || "?", 20) + "conf " + v.confidence);
  } else line("/api/atomic (server)", "HTTP " + at.status, false, at.raw.slice(0, 50));

  // ── 6. backups — bucket_audit does the real work ──────────────────────────
  console.log("");
  console.log("  BACKUPS");
  if (FEEDS_ONLY) {
    line("archive check", "skipped (--feeds)", null, "run without --feeds to open the archives");
  } else {
    try {
      const out = execFileSync("node", [path.join(ROOT, "tasks", "bucket_audit.cjs")],
                               { encoding: "utf8", timeout: 180000 });
      // Reuse its verdict rather than re-deriving one. Its own lines already carry the
      // newest archive, its age, its entry count and the required files inside it.
      for (const l of out.split(/\r?\n/)) {
        if (/newest|age |size |entries:|BOTH BUCKETS|SOMETHING IS MISSING|\*\*/.test(l) && l.trim())
          console.log("   " + l.trim());
      }
    } catch (e) {
      const out = (e.stdout || "").toString();
      for (const l of out.split(/\r?\n/)) {
        if (/newest|age |size |entries:|BOTH BUCKETS|SOMETHING IS MISSING|\*\*/.test(l) && l.trim())
          console.log("   " + l.trim());
      }
      if (!out) console.log("   bucket_audit could not run: " + e.message.slice(0, 80));
    }
  }

  console.log("");
  console.log("  Every row states its AGE. Present and current are different claims.");
  console.log("=========================================================================");
  console.log("");
  process.exit(0);
})();
