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
  // FILE FIRST, API SECOND, AND ON PURPOSE.
  //
  // /api/atomic and /api/preopen-plan are session-gated - correctly - and this script is a
  // cron job with no browser cookie, so through the API they both answered 401 and the
  // table read "no data" for two of its four sources. That is the worst possible failure
  // here: a gated endpoint and a genuinely silent source look identical, and the whole
  // point of this table is that a missing source is never counted as agreement.
  //
  // Reading the files directly also means the table still works when the server is down,
  // which is exactly when someone would want to know what each source last said.
  const sigRes   = await get("/api/signals");           // ungated by design
  const alertRes = await get("/api/alerts");            // gated; handled below
  const sigs = sigRes.json || {};

  const atoms = {};
  try {
    const base = path.join(require("os").homedir(), "AppData", "Roaming", "MetaQuotes", "Terminal");
    for (const e of fs.readdirSync(base)) {
      const d = path.join(base, e, "MQL5", "Files", "atomic_analyst");
      let files = [];
      try { files = fs.readdirSync(d).filter(f => f.endsWith(".json")); } catch { continue; }
      for (const f of files) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
          if (rec && rec.source === "ATOMIC_ANALYST_V84" && rec.symbol) {
            const ageMin = Number.isFinite(rec.generatedAtEpoch)
              ? (Date.now() / 1000 - rec.generatedAtEpoch) / 60 : null;
            atoms[String(rec.symbol).toUpperCase()] = {
              symbol: rec.symbol, direction: rec.direction, confidence: rec.confidence,
              finalConsensus: rec.finalConsensus, mtfAligned: rec.mtfAligned,
              ticket: rec.ticket, ageMinutes: ageMin,
              stale: ageMin === null || ageMin > 30,
            };
          }
        } catch { /* half-written file - next run picks it up */ }
      }
    }
  } catch { /* no MT5 data folder on this box */ }

  const planByKey = {};
  try {
    const pl = JSON.parse(fs.readFileSync(path.join(ROOT, "tasks", "analysis", "preopen-plan-latest.json"), "utf8"));
    for (const a of pl.assets || []) planByKey[a.key] = a;
  } catch { /* no plan yet today */ }

  const alerts = (alertRes.json?.alerts) || [];
  const alertsGated = alertRes.status === 401;

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
      + pad(src.tv.dir ?? (alertsGated ? "gated" : "no data"), 14)
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

    // ── SIZE, AND WHETHER THE CAP WILL QUIETLY CHANGE THE TRADE ──────────────────────
    //
    // This is the single measured reason the system is positive in R and negative in
    // money. Proven against the live sizer on 2026-09-08, same symbol, same 0.15% risk,
    // ONLY the stop distance changing:
    //
    //     stop  2.09 pts -> wants 92.4 lots -> capped at 2 -> risks   $3.08   (2.2%)
    //     stop 89.06 pts -> wants  2.2 lots -> capped at 2 -> risks $131.41  (92.2%)
    //
    // A 43x difference in real money, and the ledger records both as 1R. On a tight stop
    // the cap truncates the position to a fraction of intended risk, so a tight-stop
    // WINNER pays a few dollars while a wide-stop LOSER costs the full amount. That is
    // riskDollarsPerR spanning 1.46 to 449.72.
    //
    // So the number that matters before a manual entry is not the lot size, it is what
    // FRACTION of intended risk that lot size actually carries. It is stated outright.
    if (sig && sig.entry && sig.stop) {
      const bal = Number(process.env.SE_BALANCE) || 95000;
      const riskPct = 0.0015;                 // matches live strategy_settings riskPercent 0.15
      const cap = 2.0;                        // matches live maxLotSize
      const intended = bal * riskPct;
      const r = await post("/api/size", {
        accountBalance: bal,
        signal: { symbol: h.asset.broker, signal: h.direction, direction: h.direction,
                  entry: sig.entry, stop: sig.stop, target: sig.target ?? sig.entry,
                  confidence: sig.confidence ?? 70, atr: sig.atr },
        openPositions: [],
      });
      let want = 0;
      try { want = JSON.parse(r.raw).suggestedSize || 0; } catch {}
      const taken = Math.min(want, cap);
      const frac  = want > 0 ? (taken / want) : 0;
      const actual = intended * frac;
      L.push("");
      L.push(`<b>SIZE</b>  risk-based ${want.toFixed(2)} lots, cap ${cap} -> <b>${taken.toFixed(2)} lots</b>`);
      L.push(`intended risk $${intended.toFixed(2)} · actual risk $${actual.toFixed(2)} (${(frac * 100).toFixed(0)}% of intended)`);
      if (frac < 0.75 && want > 0) {
        L.push(`<b>CAP TRUNCATES THIS TRADE.</b> Its stop is tight enough that the position is cut to `
             + `${(frac * 100).toFixed(0)}% of normal risk. A win here pays a fraction of what a `
             + `wide-stop loss costs — that asymmetry is why the ledger reads +R and -money. `
             + `Either widen the stop so the size fits under the cap, or skip it.`);
      } else if (want > 0) {
        L.push(`Size fits under the cap — this trade carries normal risk and its R is comparable to the others.`);
      }
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
