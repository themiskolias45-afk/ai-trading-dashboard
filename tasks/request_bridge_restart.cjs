#!/usr/bin/env node
// Restart the MT5 bridge WITHOUT an elevated shell.
//
// WHY THIS EXISTS. The bridge runs elevated on the laptop, so a normal shell cannot stop
// it: Stop-Process returns "Access is denied", and registering a RunLevel Highest task to
// do the job is refused for the same reason. That is Windows working correctly. The cost
// was that every bridge code change waited on a human opening an Administrator prompt, and
// on 2026-09-03 that held up a stop-loss change for hours while positions ran unmanaged by
// the new ladder.
//
// So the bridge is ASKED to stand down instead of being killed:
//   1. POST /api/mt5/restart-bridge      sets a flag - localhost only, since this stops a
//                                        trading bridge and must not be a remote action
//   2. the bridge's next control poll    sees it, calls mt5.shutdown() and exits 0. That
//                                        happens at the TOP of the poll, before any order
//                                        is placed or modified
//   3. Start-ScheduledTask 'Ensure...'   brings it straight back. That task never kills
//                                        anything, it only fills gaps, so triggering it is
//                                        safe at any moment
//
// Broker-side SL and TP stay live throughout, exactly as on any restart. Nothing is closed.
//
//   node tasks/request_bridge_restart.cjs            ask, then verify
//   node tasks/request_bridge_restart.cjs --dry-run  report what it would do
"use strict";

const http = require("http");
const { execFileSync } = require("child_process");

const HOST = "127.0.0.1";
const PORT = 3001;
const DRY = process.argv.includes("--dry-run");
const ENSURE_TASK = "SmartEntry Ensure Running";

function req(method, path, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const r = http.request({ host: HOST, port: PORT, path, method, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, json: null, body }); }
      });
    });
    r.on("error", (e) => resolve({ error: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ error: "timeout" }); });
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const health = await req("GET", "/api/mt5/health?account=A");
  if (health.error || !health.json) { console.error("server not answering: " + (health.error || health.status)); process.exit(1); }
  if (!health.json.connected) { console.error("bridge is not currently reporting — refusing, this is not the moment to restart it"); process.exit(2); }
  const before = health.json.lastSeen;
  console.log("bridge reporting, last seen " + before);

  const risk = await req("GET", "/api/risk-status");
  if (risk.json && risk.json.halted) { console.error("trading is HALTED — refusing; investigate the halt first"); process.exit(3); }

  const pos = await req("GET", "/api/mt5/positions");
  const open = (pos.json && pos.json.positions) || [];
  const naked = open.filter((p) => !Number.isFinite(Number(p.sl)) || Number(p.sl) === 0);
  console.log(open.length + " engine position(s) open" + (open.length ? ", all with broker-side stops" : ""));
  if (naked.length) { console.error(naked.length + " position(s) have NO broker stop — refusing, they would be unprotected through the gap"); process.exit(4); }

  if (DRY) { console.log("DRY RUN — would request the restart and then trigger '" + ENSURE_TASK + "'. Nothing done."); return; }

  const ask = await req("POST", "/api/mt5/restart-bridge");
  if (ask.error || !ask.json || ask.json.ok !== true) {
    console.error("restart request refused: " + (ask.error || JSON.stringify(ask.json || ask.body)));
    console.error("(the server may predate this endpoint — restart the server first)");
    process.exit(5);
  }
  console.log("restart requested; waiting for the bridge to stand down …");

  // The bridge polls on its own interval, so give it room.
  let stoodDown = false;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const h = await req("GET", "/api/mt5/health?account=A");
    if (h.json && h.json.lastSeen === before) continue;      // still the same heartbeat
    if (h.json && !h.json.connected) { stoodDown = true; break; }
    if (h.json && h.json.ageMs > 90000) { stoodDown = true; break; }
  }
  console.log(stoodDown ? "  bridge has stood down" : "  bridge still reporting — it may not carry the stand-down code yet");

  try {
    execFileSync("powershell", ["-NoProfile", "-Command", "Start-ScheduledTask -TaskName '" + ENSURE_TASK + "'"], { stdio: "pipe" });
    console.log("triggered '" + ENSURE_TASK + "' to bring it back");
  } catch (e) {
    console.error("could not trigger " + ENSURE_TASK + ": " + e.message);
    console.error("it runs on its own schedule anyway; the bridge returns within ~10 minutes");
  }

  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const h = await req("GET", "/api/mt5/health?account=A");
    if (h.json && h.json.connected && h.json.lastSeen !== before) {
      console.log("bridge back and reporting, last seen " + h.json.lastSeen);
      const p2 = await req("GET", "/api/mt5/positions");
      console.log("engine positions after: " + (((p2.json || {}).positions) || []).length + " (was " + open.length + ")");
      return;
    }
  }
  console.error("bridge has NOT come back within 2 minutes — check tasks/logs/bridge_log_A.txt before doing anything else");
  process.exit(6);
})();
