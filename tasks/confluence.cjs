// CONFLUENCE — the six independent reads of the same market, side by side.
//
// WHY. Six things form an opinion on BTC, GOLD and SP500 and none of them can see the
// others: the SmartEntry engine, the pre-open plan, the DAILY PLAN, the ATOMIC_ANALYST_V84
// indicator, the EA_CRT_AMD chart EA, and whatever TradingView last alerted.
//
// EA CRT IS A SOURCE BECAUSE IT IS THE ONLY ONE WITH ITS OWN MONEY DOWN. Every other
// column is an opinion; the EA has actually taken the trade, on its own magic, sized by
// its own rules, and a halt on this system cannot even reach it. Its direction is read
// from the LIVE POSITION BOOK rather than from any status panel - measured 2026-09-08,
// the CRT dashboard panel showed XAUUSD 0.12 @4413.73 while the account really held
// 0.31 @4403.91, so a panel is not evidence about a position. NO OPEN CRT POSITION IS
// SILENCE, NOT A "WAIT": an EA with no trade on may simply have had no setup, and
// scoring that as agreement would invent a vote nobody cast.
//
// THE DAILY PLAN IS ITS OWN SOURCE, not a synonym for the pre-open plan. They are written
// by different jobs at different times off different inputs: the daily plan runs pre-dawn
// and carries the LEVELS, the day's ATR and its warnings; the pre-open plan runs at the
// open and carries a scored setup. Folding them into one column showed FOUR sources where
// he had named five, and hid the case where the level map disagrees with the open.
// ONLY TODAY'S daily plan may contribute a direction. An older file is displayed with its
// date and contributes null, because a stale plan agreeing is not agreement. Agreement between independent readers is the only
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
const { spawnSync } = require("child_process");

const ROOT   = path.join(__dirname, "..");
const STATE  = path.join(ROOT, "tasks", "confluence_state.json");
// EVERY READING IS RECORDED, NOT JUST THE ONES THAT ALERT.
//
// He asked for better learning and more evidence, and an alert-only tool can never
// provide either: it keeps the six cases where everything agreed and throws away the
// several thousand where it did not. You cannot ask "is agreement worth anything?" of a
// file that only contains agreements - that is selecting on the outcome.
//
// So one line per asset per run goes here regardless of verdict, with every source's
// direction and the price at the time. Append-only and never rotated, per the standing
// rule. It feeds nothing and gates nothing today; it exists so that in a few weeks the
// question "which combination actually preceded a move?" has a population to ask.
const LEDGER = path.join(ROOT, "tasks", "confluence_ledger.jsonl");

// EA_CRT_AMD magics. 26070455 is the current v3.55/56 line; the two older ones are kept
// because a position opened by an earlier build is still the EA's position and still the
// EA's opinion. Sourced from tasks/ea_crt_weekly_review.py, which owns this list.
const CRT_MAGICS = new Set([26070401, 26070402, 26070455]);
// The snapshot is written by tasks/mt5_positions_snapshot.py. Older than this and it
// cannot be called a current read of the book.
const SNAPSHOT_STALE_MINUTES = 30;
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
  const setRes   = await get("/api/strategy-settings"); // GET is public: the bridge polls it
  // KICK THE POSITION SNAPSHOT, or EA CRT can never vote on a headless box.
  //
  // The server refreshes tasks/mt5_positions_snapshot.json LAZILY - refreshPositionSnapshot()
  // is called from the GET /api/mt5/positions handler and nowhere else, explicitly "for
  // NEXT time". On the laptop an open dashboard polls that route constantly so the file
  // stays fresh; the VPS is headless, nothing ever asks, and measured 2026-09-08 its
  // snapshot was 47 MINUTES old - past the 30-minute bar - so the EA CRT column read
  // "no book" on the one box that trades continuously.
  //
  // This request costs nothing (the route is public and serves from the last file
  // regardless) and leaves a fresh snapshot for the NEXT run. At a 15-minute cadence the
  // file is therefore at most one interval old, comfortably inside the bar. The result is
  // deliberately ignored: we read the FILE below, because the file is what survives a
  // server restart.
  await get("/api/mt5/positions");
  const alertRes = await get("/api/alerts");            // gated; handled below
  const sigs = sigRes.json || {};
  // THE LIVE GATE, READ NOT ASSUMED. It moved 65 -> 70 once and the boot file was the
  // last thing still claiming 65. null here means the read failed, never a default.
  const liveGate = Number.isFinite(Number(setRes.json?.confidenceThreshold))
                     ? Number(setRes.json.confidenceThreshold) : null;

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

  // ── EA CRT — read from the LIVE POSITION BOOK, not from a status panel ────────────
  // Net lots per symbol across the CRT magics. Long and short both open on the same
  // symbol nets to WAIT (the EA is hedged and has no directional opinion right now),
  // which is a considered verdict; NO position at all is null, which is silence.
  const crtBySymbol = {};
  let crtSnapshotAgeMin = null, crtSnapshotOk = false;
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "tasks", "mt5_positions_snapshot.json"), "utf8"));
    const at = snap && snap.at ? Date.parse(snap.at) : NaN;
    crtSnapshotAgeMin = Number.isFinite(at) ? (Date.now() - at) / 60000 : null;
    // A stale book is not a current opinion. Say so rather than voting on old positions.
    crtSnapshotOk = snap && snap.ok !== false && crtSnapshotAgeMin !== null
                    && crtSnapshotAgeMin <= SNAPSHOT_STALE_MINUTES;
    if (crtSnapshotOk) {
      for (const pos of snap.positions || []) {
        if (!CRT_MAGICS.has(Number(pos.magic))) continue;
        const sym = String(pos.symbol || "").toUpperCase();
        if (!sym) continue;
        const lots = Number(pos.volume) || 0;
        const isBuy = String(pos.type || pos.direction || "").toUpperCase().startsWith("BUY");
        const e = crtBySymbol[sym] || (crtBySymbol[sym] = { longLots: 0, shortLots: 0, tickets: 0 });
        if (isBuy) e.longLots += lots; else e.shortLots += lots;
        e.tickets += 1;
      }
    }
  } catch { /* no snapshot on this box - the column reads "no data", never agreement */ }

  const planByKey = {};
  try {
    const pl = JSON.parse(fs.readFileSync(path.join(ROOT, "tasks", "analysis", "preopen-plan-latest.json"), "utf8"));
    for (const a of pl.assets || []) planByKey[a.key] = a;
  } catch { /* no plan yet today */ }

  // ── THE DAILY PLAN — its own source, and only if it is TODAY'S ─────────────────────
  // trade_plan is null on most days; that is a real state ("levels mapped, no setup") and
  // it renders as "no plan", never counted as agreement. The levels and warnings are
  // carried into the alert regardless, because they are the evidence a manual entry needs.
  let daily = null, dailyDate = null, dailyStale = false;
  {
    const todayKey = new Date().toISOString().slice(0, 10);
    const readPlan = (d) => {
      try { return JSON.parse(fs.readFileSync(path.join(ROOT, "tasks", "daily_plan_" + d + ".json"), "utf8")); }
      catch { return null; }
    };
    daily = readPlan(todayKey);
    if (daily) { dailyDate = todayKey; }
    else {
      try {
        const names = fs.readdirSync(path.join(ROOT, "tasks"))
          .filter((f) => /^daily_plan_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
        if (names.length) {
          dailyDate = names[names.length - 1].slice(11, 21);
          daily = readPlan(dailyDate);
          dailyStale = true;   // present, but NOT today - contributes nothing to agreement
        }
      } catch { /* no tasks dir - impossible here, but never throw on a read */ }
    }
  }

  const alerts = (alertRes.json?.alerts) || [];
  const alertsGated = alertRes.status === 401;

  console.log("");
  console.log("============== CONFLUENCE — six independent reads of the same market ==============");
  console.log("  " + pad("ASSET", 7) + pad("SYSTEM", 15) + pad("PRE-OPEN", 15)
              + pad("DAILY PLAN", 15) + pad("ATOMIC", 17) + pad("EA CRT", 14)
              + pad("TRADINGVIEW", 13) + "VERDICT");
  if (crtSnapshotAgeMin !== null && !crtSnapshotOk)
    console.log("  position snapshot is " + crtSnapshotAgeMin.toFixed(0) + "m old — EA CRT reads 'no book' and votes on nothing");
  if (daily && dailyStale)
    console.log("  daily plan on file is " + dailyDate + ", NOT today — shown for reference, contributes nothing");
  else if (!daily)
    console.log("  no daily_plan_*.json found at all — that column reads 'no file'");

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
      daily:  (() => {
                const d = daily && daily.assets ? daily.assets[a.key] : null;
                const tp = d && d.trade_plan ? d.trade_plan : null;
                return {
                  // A stale file never contributes a direction, however confident it reads.
                  dir: (tp && !dailyStale) ? dir(tp.direction || tp.signal || tp.bias) : null,
                  conf: tp?.confidence ?? null,
                  setup: tp?.setup ?? tp?.strategy ?? null,
                  hasFile: !!daily, hasAsset: !!d, hasPlan: !!tp, stale: dailyStale,
                  levels: d?.levels || null, atr: d?.context?.atr ?? null, price: d?.price ?? null,
                };
              })(),
      atomic: { dir: atom ? dir(atom.direction) : null, conf: atom?.confidence ?? null,
                stale: atom?.stale, consensus: atom?.finalConsensus ?? null, mtf: atom?.mtfAligned },
      tv:     { dir: tvRow ? dir(tvRow.action) : null, at: tvRow?.ts ?? null },
      crt:    (() => {
                const e = crtBySymbol[a.broker];
                if (!crtSnapshotOk || !e) {
                  return { dir: null, lots: null, tickets: 0,
                           why: !crtSnapshotOk ? "no book" : "flat" };
                }
                const net = e.longLots - e.shortLots;
                const d = net > 0 ? "BUY" : net < 0 ? "SELL" : "WAIT";   // exactly hedged = WAIT
                return { dir: d, lots: Math.abs(Math.round(net * 100) / 100), tickets: e.tickets, why: null };
              })(),
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

    // Each cell says WHICH KIND of nothing it is. "no plan" (ran, mapped levels, found no
    // setup), "STALE" (a real opinion, too old to count) and "no file" (never ran) are three
    // different facts about the system, and one dash would have hidden all three.
    const dailyCell = src.daily.dir
                        ? src.daily.dir + (src.daily.conf != null ? " " + src.daily.conf + "%" : "")
                    : !src.daily.hasFile  ? "no file"
                    : !src.daily.hasAsset ? "not in plan"
                    : src.daily.stale     ? (src.daily.hasPlan ? "STALE" : "stale/no plan")
                    :                       "no plan";
    console.log("  " + pad(a.label, 7)
      + pad((src.system.dir ?? "—") + (src.system.conf != null ? " " + src.system.conf + "%" : ""), 15)
      + pad((src.plan.dir ?? "—") + (src.plan.conf != null ? " " + src.plan.conf + "%" : ""), 15)
      + pad(dailyCell, 15)
      + pad((src.atomic.dir ?? "no data") + (src.atomic.conf != null ? " " + src.atomic.conf + "%" : "")
            + (src.atomic.stale ? " STALE" : ""), 17)
      + pad(src.crt.dir
              ? src.crt.dir + " " + src.crt.lots + "L"
              : (src.crt.why === "no book" ? "no book" : "flat"), 14)
      + pad(src.tv.dir ?? (alertsGated ? "gated" : "no data"), 13)
      + verdict);

    rows.push({ asset: a, src, agreed, direction: nonWait[0] || null, present: present.map(([k]) => k),
                missing: Object.keys(src).filter(k => src[k].dir === null), sig, atom, plan });
  }

  console.log("");
  console.log("  A source with NO DATA is never counted as agreement. Full agreement needs");
  console.log("  every present source on the same non-WAIT side, and at least 3 present.");
  console.log("  The 3-present floor is UNCHANGED from the four-source version on purpose:");
  console.log("  adding a fifth or sixth reader must not raise the bar and silence a real");
  console.log("  agreement. EA CRT 'flat' means no open position — silence, not a WAIT vote,");
  console.log("  because an EA with no trade on may simply have had no setup.");
  console.log("===========================================================================");

  // ── THE EVIDENCE LEDGER — written BEFORE the early exit, on purpose ───────────────
  //
  // This append must happen above the "no full agreement" return. If it sat below it, the
  // file would contain ONLY the runs where everything agreed, and the one question worth
  // asking of it - "is agreement worth anything?" - would be unanswerable, because the
  // disagreements it needs as a control were never recorded. Selecting on the outcome is
  // how a ledger becomes a scrapbook.
  //
  // Append-only, never rotated, one line per asset per run. It feeds nothing and gates
  // nothing: no confidence, no size, no stop reads this file. It is a population being
  // accumulated so a walk-forward can be run on it later, and a claim about which
  // combination predicts anything is NOT supported until that has happened.
  try {
    const stamp = new Date().toISOString();
    const lines = rows.map((r) => JSON.stringify({
      at: stamp,
      box: require("os").hostname(),
      asset: r.asset.key,
      broker: r.asset.broker,
      price: r.sig?.price ?? null,
      // Each source's direction as it stood. null is preserved and NEVER coerced to
      // "WAIT" - the difference between silence and a considered wait is the whole point.
      system:  { dir: r.src.system.dir,  conf: r.src.system.conf,  setup: r.src.system.setup },
      preopen: { dir: r.src.plan.dir,    conf: r.src.plan.conf,    setup: r.src.plan.setup },
      daily:   { dir: r.src.daily.dir,   conf: r.src.daily.conf,   stale: r.src.daily.stale },
      atomic:  { dir: r.src.atomic.dir,  conf: r.src.atomic.conf,  stale: r.src.atomic.stale },
      crt:     { dir: r.src.crt.dir,     lots: r.src.crt.lots,     tickets: r.src.crt.tickets },
      tv:      { dir: r.src.tv.dir,      at: r.src.tv.at },
      presentCount: r.present.length,
      present: r.present,
      missing: r.missing,
      agreed: r.agreed,
      // ONLY SET WHEN THEY ACTUALLY AGREED. This used to carry the first non-WAIT
      // direction found even on a split row, which reads like a call the table never
      // made. dirsSeen carries the raw spread instead, so a disagreement stays visible.
      direction: r.agreed ? r.direction : null,
      dirsSeen: r.present.map((k) => r.src[k].dir),
      // The gate at the time, so a later reader never has to guess which regime the row
      // was recorded under. Read live from /api/strategy-settings - the first version of
      // this line read sigs.__gate, a key nothing has ever written, so every row would
      // have recorded gate:null while looking like it had been captured.
      gate: liveGate,
      feedsTheGate: false,
    }));
    const NL = String.fromCharCode(10);
    fs.appendFileSync(LEDGER, lines.join(NL) + NL);
  } catch (e) {
    // A ledger that cannot be written must be LOUD, but must never stop the alert that
    // this script exists to send.
    console.log("  LEDGER WRITE FAILED: " + e.message + " — the table above is unaffected");
  }

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
    // THE BOX IS NAMED IN THE MESSAGE. Both machines run this on their own schedule and
    // they are not saying the same thing: measured 2026-09-08 at the same minute, SPX read
    // SYSTEM 75% / ATOMIC 71.4% here and SYSTEM 91% / ATOMIC 85.7% on the VPS, off separate
    // MT5 terminals and separate accounts. Two unlabelled alerts would look like a duplicate
    // send, and the natural fix for a duplicate is to silence one box — which is exactly how
    // you end up with no alert at all on the day the other one is asleep.
    L.push(`<b>CONFLUENCE — ${h.asset.label} ${h.direction}</b>  <i>[${require("os").hostname()}]</i>`);
    L.push(`${h.present.length} of 5 sources agree${h.missing.length ? ` · no data from: ${h.missing.join(", ")}` : ""}`);
    L.push("");
    L.push(`<b>SYSTEM</b>  ${h.src.system.dir} · conf ${h.src.system.conf}% · ${h.src.system.setup ?? "—"}`);
    L.push(`<b>PLAN</b>    ${h.src.plan.dir} · conf ${h.src.plan.conf}% · ${h.src.plan.setup ?? "—"}${h.src.plan.ready ? " · READY" : ""}`);
    L.push(`<b>DAILY PLAN</b> ${h.src.daily.dir
              ?? (h.src.daily.hasFile
                    ? (h.src.daily.stale ? "stale (" + dailyDate + ")" : "no setup — levels only")
                    : "no file")}`
          + (h.src.daily.conf != null ? ` · conf ${h.src.daily.conf}%` : "")
          + (h.src.daily.setup ? ` · ${h.src.daily.setup}` : ""));
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

    // ── THE DAY'S LEVEL MAP ─────────────────────────────────────────────────────────
    // The daily plan's real contribution on a no-setup day: WHERE the day's pivot and
    // zones actually sit. A manual entry is taken or skipped on where price stands against
    // these, so they travel with the alert even when trade_plan is null. Distance from the
    // pivot is expressed in ATR because 40 points means nothing without the day's range.
    if (h.src.daily.levels) {
      const lv = h.src.daily.levels;
      L.push("");
      L.push(`<b>DAILY LEVELS</b> (${dailyDate}${dailyStale ? " — STALE, not today" : ""}, source ${lv.source ?? "—"})`);
      L.push(`R2 ${lv.R2 ?? "—"} · R1 ${lv.R1 ?? "—"} · pivot ${lv.pivot ?? "—"} · S1 ${lv.S1 ?? "—"} · S2 ${lv.S2 ?? "—"}`);
      if (h.src.daily.atr != null) {
        const atrVal = Number(h.src.daily.atr) || 0;
        const pv = lv.pivot;
        const fromPivot = (sig?.entry != null && pv != null && atrVal > 0)
          ? ` · entry sits ${((sig.entry - pv) / atrVal).toFixed(2)} ATR from pivot` : "";
        L.push(`daily ATR ${h.src.daily.atr}${fromPivot}`);
      }
      const warn = (daily?.warnings || []).filter(Boolean);
      if (warn.length)
        L.push(`<b>PLAN WARNINGS</b> ${warn.map((w) => typeof w === "string" ? w : (w.message || w.text || JSON.stringify(w))).join(" · ").slice(0, 400)}`);
      const cal = (daily?.calendar?.events || (Array.isArray(daily?.calendar) ? daily.calendar : []));
      if (Array.isArray(cal) && cal.length)
        L.push(`<b>CALENDAR</b> ${cal.slice(0, 4).map((e) => `${e.time ?? e.at ?? "?"} ${e.title ?? e.name ?? e.event ?? "?"}`).join(" · ").slice(0, 300)}`);
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

    // NOT /api/agent/notify. That route is guarded by AGENT_RELAY_SECRET for the cloud
    // research agent, the secret was never passed here, and every send this script ever
    // attempted answered 403 "invalid or missing secret" — the alert half of this feature
    // had never once been deliverable. Proven 2026-09-08 by running it.
    //
    // tasks/send_telegram.py posts straight to the Telegram API off keys.env, so it needs
    // no shared secret, works with the server down, and — unlike notifications.send_telegram,
    // which returns None whether it sent or not — it prints SENT / NOCONFIG / FAILED and
    // exits non-zero. A confluence alert that fails silently is precisely the failure this
    // table exists to prevent, so the outcome is asserted, not assumed.
    //
    // Plain text, tags stripped: send_telegram sets no parse_mode, so <b> would arrive
    // literally. The message is piped on stdin, never placed in an argv.
    const plain = msg.replace(/<[^>]+>/g, "");
    const py = process.env.SMARTENTRY_PYTHON || "python";
    const send = spawnSync(py, [path.join(ROOT, "tasks", "send_telegram.py")],
                           { input: plain, encoding: "utf8", timeout: 30000 });
    const verdict = String(send.stdout || "").trim() || String(send.stderr || "").trim()
                    || (send.error ? send.error.message : "no output");
    if (send.status === 0 && /^SENT/.test(verdict)) {
      // The dedupe key is written ONLY on a confirmed send. Recording it on a failure
      // would suppress every retry for the rest of the day over one transient error.
      state[stateKey] = new Date().toISOString(); sent++;
      console.log(`  [telegram] ${verdict}`);
    } else {
      console.log(`  [telegram] NOT SENT — ${verdict.slice(0, 200)}`);
      console.log(`  [telegram] the alert above was NOT delivered; the dedupe key was not written, so the next run retries.`);
    }
  }

  if (NOTIFY && sent) {
    try { fs.writeFileSync(STATE, JSON.stringify(state, null, 2), "utf8"); } catch (e) { console.log("  state not saved: " + e.message); }
  }
  console.log("");
  process.exit(0);
})();
