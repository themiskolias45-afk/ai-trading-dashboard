// ATOMIC ANALYST FEED READER — ships the indicator's JSON into the server.
//
// WHY A READER AND NOT A DIRECT POST. MQL5 forbids WebRequest() inside an indicator: the
// call returns -1 with error 4014, "function not allowed for call". Only EAs and scripts
// may use it. ATOMIC_ANALYST_V84 is deliberately an INDICATOR - it has no trade functions
// available to it at all, so it cannot place, modify or close an order even by mistake,
// and it does not occupy the chart's expert slot. The price of that safety is that it
// writes a file and something else carries it. This is that something else.
//
// WHAT IT IS ALLOWED TO DO: read files, POST them to /api/atomic/verdict, exit.
// WHAT IT MUST NEVER DO: influence a signal. The payload carries feedsTheGate:false and
// the endpoint stores it beside the engine, never inside it. This is a second opinion from
// an unvalidated third-party indicator; wiring it into confidence, the 70 gate, position
// size or a stop would put a paper read on the live decision path, which is exactly the
// mistake `shadow` is kept separate to avoid.
//
// STALENESS IS REPORTED, NEVER HIDDEN. The MT4 panel this ports from showed a ticket
// stamped four days earlier underneath a live-looking header. Every record shipped here
// carries its own age and the server marks it stale rather than serving it as current.
//
//   node tasks/atomic_feed_reader.cjs           read, ship, report
//   node tasks/atomic_feed_reader.cjs --dry     read and report, ship nothing

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const DRY  = process.argv.includes("--dry");
const HOST = "127.0.0.1";
const PORT = 3001;
const MAX_AGE_MIN = 30;          // older than this is reported as stale, not as a verdict
const MAX_BYTES   = 256 * 1024;  // a verdict file is ~2KB; anything near this is not one

function terminalFileDirs() {
  const base = path.join(os.homedir(), "AppData", "Roaming", "MetaQuotes", "Terminal");
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(base); } catch { return out; }
  for (const entry of entries) {
    const dir = path.join(base, entry, "MQL5", "Files", "atomic_analyst");
    try { if (fs.statSync(dir).isDirectory()) out.push({ terminal: entry, dir }); }
    catch { /* this terminal has no atomic feed - normal */ }
  }
  return out;
}

function post(pathname, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
        timeout: 8000 },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: raw.slice(0, 400) }));
      });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.write(data);
    req.end();
  });
}

(async () => {
  const dirs = terminalFileDirs();
  console.log("");
  console.log("=== ATOMIC FEED READER " + (DRY ? "[DRY]" : "") + " ===");
  if (!dirs.length) {
    // Not an error. The indicator may simply not be attached to a chart yet, and a reader
    // that exits 1 on that would turn "nobody has attached it" into a red scheduled task.
    console.log("  no atomic_analyst folder in any terminal - indicator not attached yet");
    process.exit(0);
  }

  let shipped = 0, skipped = 0, failed = 0;
  for (const t of dirs) {
    let files = [];
    try { files = fs.readdirSync(t.dir).filter((f) => f.toLowerCase().endsWith(".json")); }
    catch (e) { console.log("  " + t.terminal.slice(0, 8) + ": unreadable - " + e.message); failed++; continue; }

    for (const f of files) {
      const full = path.join(t.dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > MAX_BYTES) {
        console.log("  " + f + ": " + stat.size + " bytes, refusing - not a verdict file");
        skipped++; continue;
      }
      let rec;
      try { rec = JSON.parse(fs.readFileSync(full, "utf8")); }
      catch (e) {
        // A half-written file is normal: the indicator may be mid-write. Skip it and let
        // the next run pick it up rather than reporting a failure.
        console.log("  " + f + ": not parseable yet (" + e.message.slice(0, 60) + ") - skipping");
        skipped++; continue;
      }
      if (!rec || rec.source !== "ATOMIC_ANALYST_V84" || !rec.symbol) {
        console.log("  " + f + ": not an ATOMIC_ANALYST_V84 record - skipping");
        skipped++; continue;
      }

      const ageMin = Number.isFinite(rec.generatedAtEpoch)
        ? (Date.now() / 1000 - rec.generatedAtEpoch) / 60 : null;
      const stale = ageMin === null || ageMin > MAX_AGE_MIN;

      console.log("  " + String(rec.symbol).padEnd(10) +
        " " + String(rec.verdict || "?").padEnd(18) +
        " conf " + String(rec.confidence ?? "?").padStart(5) +
        "  mtfAligned " + String(rec.mtfAligned) +
        "  age " + (ageMin === null ? "unknown" : ageMin.toFixed(1) + "m") +
        (stale ? "  <<< STALE, shipped as stale" : ""));

      if (DRY) { skipped++; continue; }
      const res = await post("/api/atomic/verdict", {
        terminal: t.terminal, ageMinutes: ageMin, stale, record: rec,
      });
      if (res.status === 200) shipped++;
      else { failed++; console.log("      POST failed: " + res.status + " " + res.body); }
    }
  }
  console.log("");
  console.log("  shipped " + shipped + ", skipped " + skipped + ", failed " + failed);
  // Exit 0 even with failures: this is an evidence feed, and a red scheduled task for a
  // second opinion that did not arrive would bury the reds that actually matter.
  process.exit(0);
})();
