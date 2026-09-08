// CONFLUENCE — the four independent reads of the same market, side by side.
//
// WHY. Four things form an opinion on BTC, GOLD and SP500 and none of them can see the
// others: the SmartEntry engine, the pre-open plan, the ATOMIC_ANALYST_V84 indicator, and
// whatever TradingView last alerted. Agreement between independent readers is the only
// evidence here that is not just one model restating itself, and until now there was
// nowhere to see it.
//
// WHAT IT DOES NOT DO, and this is deliberate:
//   - It places no order and moves no gate. It reads and it reports.
//   - It does not average the four into a score. A blended number would hide exactly the
//     thing worth seeing, which is WHICH source disagrees.
//   - It never treats a MISSING source as agreement. A source with no data is reported as
//     "no data", counted separately, and named in the alert. Three sources agreeing while
//     a fourth is silent is a different fact from four agreeing, and the message says so.
//
// TELEGRAM: sends only on a FULL-AGREEMENT flip, and only once per direction per asset
// per day. The dedupe state lives in tasks/confluence_state.json - without it a 5-minute
// cron would send the same alert 288 times and train him to ignore the channel.
//
//   node tasks/confluence.cjs            table only
//   node tasks/confluence.cjs --notify   table, and Telegram on a new full agreement
//   node tasks/confluence.cjs --force    ignore the dedupe (for testing the message)

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT   = path.join(__dirname, "..");
const STATE  = path.join(ROOT, "tasks", "confluence_state.json");
const NOTIFY = process.argv.includes("--notify");
const FORCE  = process.argv.includes("--force");
const HOST = "127.0.0.1", PORT = 3001;

// key -> the broker symbol the ATOMIC indicator writes under
const ASSETS = [
  { key: "btc",  label: "BTC",  broker: "BTCUSD", tv: ["BTCUSD", "BTC-USD", "BTCUSDT"] },
  { key: "gold", label: "GOLD", broker: "XAUUSD", tv: ["XAUUSD", "GOLD", "GC=F"] },
  { key: "spx",  label: "SPX",  broker: "SP500",  tv: ["SP500", "SPX", "^GSPC"] },
];

function get(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: p, method: "GET", timeout: 8000 }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.end();
  });
}

function post(p, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request({ host: HOST, port: PORT, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length }, timeout: 10000 },
      (res) => { let raw = ""; res.on("data", c => raw += c); res.on("end", () => resolve({ status: res.statusCode, raw })); });
    req.on("error", (e) => resolve({ status: 0, raw: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, raw: "timeout" }); });
    req.write(data); req.end();
  });
}

// A direction, or null when the source genuinely has nothing to say. Null and "WAIT" are
// DIFFERENT: WAIT is a considered verdict, null is silence.
function dir(v) {
  const s = String(v || "").toUpperCase();
  if (s.startsWith("BUY") || s === "LONG")  return "BUY";
  if (s.startsWith("SELL") || s === "SHORT") return "SELL";
  if (s === "WAIT" || s === "NONE" || s === "FLAT") return "WAIT";
  return null;
}

const pad = (s, n) => String(s == null ? "—" : s).padEnd(n);

(async () => {
  const [sigRes, atomRes, planRes, alertRes] = await Promise.all([
    get("/api/signals"), get("/api/atomic"), get("/api/preopen-plan"), get("/api/alerts"),
  ]);
  const sigs = sigRes.json || {};
  const atoms = {};
  for (const v of (atomRes.json?.verdicts) || []) atoms[String(v.symbol).toUpperCase()] = v;
  const planByKey = {};
  for (const a of (planRes.json?.assets) || []) planByKey[a.key] = a;
  const alerts = (alertRes.json?.alerts) || [];

  console.log("");
  console.log("=================== CONFLUENCE — four independent reads ===================");
  console.log("  " + pad("ASSET", 7) + pad("SYSTEM", 16) + pad("PRE-OPEN PLAN", 16)
              + pad("ATOMIC", 18) + pad("TRADINGVIEW", 14) + "VERDICT");

  const rows = [];
  for (const a of ASSETS) {
    const sig  = sigs[a.key] || null;
    const plan = planByKey[a.key] || null;
    const atom = atoms[a.broker] || null;

    // Newest TradingView alert for this instrument. Trade-lifecycle rows written by our
    // own bridge ("BUY OPENED", "POSITION REVIEW") are NOT a TradingView opinion and are
    // excluded - counting them would make the system agree with itself and call it
    // confluence.
    const tvRow = alerts.find(r => a.tv.includes(String(r.ticker || "").toUpperCase())
                                && !/OPENED|CLOSED|REVIEW|MODIFIED/i.test(String(r.action || "")));

    const src = {
      system: { dir: sig ? dir(sig.signal) : null, conf: sig?.confidence ?? null, setup: sig?.setup ?? null },
      plan:   { dir: plan ? dir(plan.signal) : null, conf: plan?.confidence ?? null, setup: plan?.setup ?? null, ready: plan?.ready },
      atomic: { dir: atom ? dir(atom.direction) : null, conf: atom?.confidence ?? null,
                stale: atom?.stale, consensus: atom?.finalConsensus ?? null, mtf: atom?.mtfAligned },
      tv:     { dir: tvRow ? dir(tvRow.action) : null, at: tvRow?.ts ?? null },
    };

    const present = Object.entries(src).filter(([, v]) => v.dir !== null);
    const dirs = present.map(([, v]) => v.dir);
    const nonWait = dirs.filter(d => d !== "WAIT");
    // FULL AGREEMENT means: every source that HAS an opinion says the same non-WAIT
    // direction, and at least three of the four are present. Two sources agreeing is a
    // coincidence, not confluence.
    const agreed = nonWait.length > 0 && nonWait.length === dirs.length
                   && new Set(nonWait).size === 1 && present.length >= 3;
    const verdict = agreed ? ("AGREE " + nonWait[0])
                  : (dirs.length === 0 ? "no data"
                  : (new Set(dirs).size === 1 ? ("all " + dirs[0]) : "split"));

    console.log("  " + pad(a.label, 7)
      + pad((src.system.dir ?? "—") + (src.system.conf != null ? " " + src.system.conf + "%" : ""), 16)
      + pad((src.plan.dir ?? "—") + (src.plan.conf != null ? " " + src.plan.conf + "%" : ""), 16)
      + pad((src.atomic.dir ?? "no data") + (src.atomic.conf != null ? " " + src.atomic.conf + "%" : "")
            + (src.atomic.stale ? " STALE" : ""), 18)
      + pad(src.tv.dir ?? "no data", 14)
      + verdict);

    rows.push({ asset: a, src, agreed, direction: nonWait[0] || null, present: present.map(([k]) => k),
                missing: Object.keys(src).filter(k => src[k].dir === null), sig, atom, plan });
  }

  console.log("");
  console.log("  A source with NO DATA is never counted as agreement. Full agreement needs");
  console.log("  every present source on the same non-WAIT side, and at least 3 of 4 present.");
  console.log("===========================================================================");

  const hits = rows.filter(r => r.agreed);
  if (!hits.length) { console.log(""); console.log("  No full agreement right now."); console.log(""); process.exit(0); }

  // ── the full entry detail, and the alert ────────────────────────────────────────────
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  let sent = 0;

  for (const h of hits) {
    const sig = h.sig, atom = h.atom;
    const L = [];
    L.push(`<b>CONFLUENCE — ${h.asset.label} ${h.direction}</b>`);
    L.push(`${h.present.length} of 4 sources agree${h.missing.length ? ` · no data from: ${h.missing.join(", ")}` : ""}`);
    L.push("");
    L.push(`<b>SYSTEM</b>  ${h.src.system.dir} · conf ${h.src.system.conf}% · ${h.src.system.setup ?? "—"}`);
    L.push(`<b>PLAN</b>    ${h.src.plan.dir} · conf ${h.src.plan.conf}% · ${h.src.plan.setup ?? "—"}${h.src.plan.ready ? " · READY" : ""}`);
    L.push(`<b>ATOMIC</b>  ${h.src.atomic.dir} · conf ${h.src.atomic.conf}% · consensus ${h.src.atomic.consensus ?? "—"} · MTF ${h.src.atomic.mtf ? "aligned" : "mixed"}`);
    L.push(`<b>TRADINGVIEW</b> ${h.src.tv.dir ?? "no data"}`);
    L.push("");

    if (sig) {
      L.push(`<b>ENGINE ENTRY</b>`);
      L.push(`entry ${sig.entry ?? "—"} · stop ${sig.stop ?? "—"} · target ${sig.target ?? "—"} · R:R ${sig.rr ?? "—"}`);
      L.push(`ATR ${sig.atr ?? "—"} · strength ${sig.strength ?? "—"} · regime ${sig.regime ?? "—"}`);
      const i = sig.indicators || {};
      L.push(`RSI ${i.rsi ?? "—"} · ADX ${i.adx ?? "—"} (${(i.adx ?? 0) >= 20 ? "trend" : "NO trend"}) · trendConfirmed ${sig.trendConfirmed}`);
      L.push(`MACD ${i.macd?.macd ?? "—"} vs ${i.macd?.signal ?? "—"} · hist ${i.macd?.histogram ?? "—"}`);
      L.push(`trend D1 ${sig.trend ?? "—"} · 4H ${sig.h4?.trend ?? "—"} · 1H ${sig.h1?.trend ?? "—"} · M15 ${sig.m15?.trend ?? "—"}`);
    }
    if (atom?.ticket) {
      const t = atom.ticket;
      L.push("");
      L.push(`<b>ATOMIC LADDER</b> (fib on the entry-to-stop distance)`);
      L.push(`entry ${t.entry} · SL ${t.sl} · risk ${t.riskDistance ?? "—"}`);
      for (const x of (t.tp || [])) L.push(`TP${x.level} (${x.fib}) ${x.price}`);
    }
    L.push("");
    L.push(`<i>Evidence, not an instruction. Nothing here placed an order or moved a gate.</i>`);
    const msg = L.join("\n");

    console.log("");
    console.log(msg.replace(/<[^>]+>/g, ""));

    const stateKey = `${h.asset.key}:${h.direction}:${today}`;
    if (!NOTIFY) continue;
    if (state[stateKey] && !FORCE) { console.log(`  [telegram] already sent today for ${stateKey} — not repeating`); continue; }
    const r = await post("/api/agent/notify", { title: `Confluence ${h.asset.label} ${h.direction}`, message: msg, level: "info" });
    if (r.status === 200) { state[stateKey] = new Date().toISOString(); sent++; console.log("  [telegram] sent"); }
    else console.log(`  [telegram] FAILED ${r.status} ${String(r.raw).slice(0, 120)}`);
  }

  if (NOTIFY && sent) {
    try { fs.writeFileSync(STATE, JSON.stringify(state, null, 2), "utf8"); } catch (e) { console.log("  state not saved: " + e.message); }
  }
  console.log("");
  process.exit(0);
})();
