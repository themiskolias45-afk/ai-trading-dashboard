'use strict';
/**
 * Restart an MT5 bridge ONLY when it is provably safe to do so.
 *
 * WHY THIS EXISTS. Changing BAR_COUNT_BY_TIMEFRAME (d1 300 -> 600, for EMA200
 * accuracy) only takes effect when a bridge restarts, and a bridge restart while
 * trades are open is not obviously harmless. Rather than restart on judgement,
 * this encodes the checks and refuses when any of them fail.
 *
 * WHAT WAS VERIFIED IN THE BRIDGE SOURCE (2026-08-09):
 *
 *  1. Shutdown closes nothing. The KeyboardInterrupt path is `mt5.shutdown();
 *     sys.exit(0)` — it drops the terminal API connection and exits. Open
 *     positions stay at the broker with their SL and TP.
 *
 *  2. `position_partial_taken` is an IN-MEMORY set (mt5_bridge.py:129) and is NOT
 *     persisted, so a restart forgets which trades already had their 50% taken at
 *     1R. That would matter — except the partial floors to the volume step, and
 *     for a 0.01-lot position half_vol computes to 0, falls below volume_min and
 *     is skipped. At the fixed 0.01 sizing this system trades, the partial cannot
 *     fire at all, so the forgotten flag cannot cause a second close.
 *
 *  3. The break-even SL move sits INSIDE the partial's success branch, so it
 *     cannot fire independently either.
 *
 *  4. Trailing-stop state persists in tasks/position_r_<TAG>.json and survives.
 *
 * The residual risk is a management GAP: for the seconds the bridge is down,
 * trailing stops are not advanced. Broker-side SL and TP remain active
 * throughout, so a position is never unprotected — only unmanaged.
 *
 * DEFAULT IS REFUSE. With any position open this exits without touching
 * anything. --allow-open-positions overrides, and only makes sense once the
 * volume check above still holds.
 *
 * IT NEVER CLOSES A TRADE, MODIFIES AN SL/TP, OR CHANGES A SETTING.
 *
 * Usage:
 *   node tasks/safe_bridge_restart.cjs --host localhost [--dry-run]
 *   node tasks/safe_bridge_restart.cjs --host 169.58.74.133 --task SmartEntryBridgeA
 */

const http = require("http");
const { execFileSync } = require("child_process");

function flag(name) { return process.argv.indexOf(name) !== -1; }
function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const HOST         = opt("--host", "localhost");
const TASK         = opt("--task", "SmartEntryBridgeA");
const ACCOUNT      = opt("--account", "A");
const MAX_LOT      = Number(opt("--max-lot", "0.01"));
const DRY_RUN      = flag("--dry-run");
const ALLOW_OPEN   = flag("--allow-open-positions");
const RECONNECT_TIMEOUT_MS = 5 * 60 * 1000;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: 3001, path, timeout: 10000 }, res => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name.padEnd(42) + detail);
}

(async () => {
  console.log("SAFE BRIDGE RESTART — " + HOST + " · task " + TASK + (DRY_RUN ? "  (DRY RUN)" : ""));
  console.log("Never closes a trade, never touches an SL/TP, never changes a setting.\n");
  console.log("PRE-FLIGHT");

  // 1. Server reachable.
  let risk;
  try {
    risk = await get("/api/risk-status");
    record("server reachable", true, HOST + ":3001 answering");
  } catch (e) {
    record("server reachable", false, e.message);
    console.log("\nREFUSING: cannot verify state without the server.");
    process.exit(1);
  }

  // 2. Circuit breaker. Restarting into a halt would be pointless and confusing.
  record("not halted", !risk.halted, risk.halted ? ("HALTED: " + risk.haltReason) : "trading enabled");

  // 3. Bridge currently alive — otherwise this is a start, not a restart, and
  //    ensure_running already covers that case.
  let health = null;
  try {
    health = await get("/api/mt5/health?account=" + encodeURIComponent(ACCOUNT));
    record("bridge currently reporting", health.connected === true,
      health.connected ? ("last seen " + Math.round(health.ageMs / 1000) + "s ago")
                       : (health.reason || "not connected"));
  } catch (e) {
    record("bridge currently reporting", false, e.message);
  }

  // 4. Open positions, and the volume check that makes a restart harmless.
  let positions = [];
  try {
    const body = await get("/api/mt5/positions");
    positions = body.positions || [];
  } catch (e) {
    record("positions readable", false, e.message);
    console.log("\nREFUSING: cannot enumerate positions.");
    process.exit(1);
  }

  if (positions.length === 0) {
    record("no open positions", true, "flat — restart is unambiguous");
  } else {
    const oversized = positions.filter(p => Number(p.volume) > MAX_LOT);
    console.log("       " + positions.length + " position(s) open:");
    for (const p of positions) {
      console.log("         " + p.symbol + " " + p.type + " " + p.volume + " lots"
        + "  SL " + p.sl + "  TP " + p.tp + "  P/L " + p.profit);
    }
    // A position without a broker-side stop WOULD be unprotected during the gap.
    const unprotected = positions.filter(p => !Number(p.sl));
    record("every position has a broker SL", unprotected.length === 0,
      unprotected.length === 0 ? "all protected through the gap"
        : unprotected.length + " with NO stop loss");
    // The partial-profit reset only bites if a position is large enough to split.
    record("no position can be partial-closed", oversized.length === 0,
      oversized.length === 0
        ? "all <= " + MAX_LOT + " lots, so the 1R partial is skipped by volume_min"
        : oversized.length + " position(s) above " + MAX_LOT + " could be halved after the in-memory flag resets");
    record("open positions allowed", ALLOW_OPEN,
      ALLOW_OPEN ? "--allow-open-positions given" : "pass --allow-open-positions to proceed with trades open");
  }

  // Does the thing we are about to restart actually EXIST here?
  //
  // Checked LAST but before the verdict, because without it this tool printed "All
  // pre-flight checks passed. Restarting scheduled task SmartEntryBridgeA …" on the
  // laptop and only then died on "The system cannot find the file specified" — that task
  // exists on the VPS ONLY. Every safety check had passed, so the failure read like the
  // restart had begun and something had gone wrong mid-flight, when in fact nothing was
  // ever touched. A safety tool that cannot work on one box must say so in pre-flight,
  // not after announcing success. Same shape as vps_parity.cjs, which can never succeed
  // when run ON the VPS.
  //
  // Local only: a remote host's scheduler is not queryable from here, so the check is
  // skipped rather than guessed at, and says which it did.
  if (HOST === "localhost" || HOST === "127.0.0.1") {
    let taskFound = false;
    let taskDetail = "";
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        "if (Get-ScheduledTask -TaskName '" + TASK.replace(/'/g, "''") + "' -ErrorAction SilentlyContinue) { 'FOUND' } else { 'MISSING' }"],
        { encoding: "utf8", timeout: 20000, windowsHide: true });
      taskFound = /FOUND/.test(out);
      taskDetail = taskFound
        ? "scheduled task '" + TASK + "' exists on this box"
        : "no scheduled task '" + TASK + "' here — pass --task with this box's own name. "
          + "The laptop has no per-bridge task at all: its bridges come up via "
          + "tasks/ensure_running.ps1 or START.bat, so there is nothing for this tool to cycle.";
    } catch (e) {
      taskDetail = "could not query the scheduler (" + (e.code || e.message) + ")";
    }
    record("restart target exists", taskFound, taskDetail);
  } else {
    console.log("  SKIP  restart target exists                   " + HOST + " is remote; its scheduler is not queryable from here");
  }

  const failed = checks.filter(c => !c.ok);
  if (failed.length) {
    console.log("\nREFUSING — " + failed.length + " check(s) failed:");
    failed.forEach(c => console.log("   - " + c.name + ": " + c.detail));
    console.log("\nNothing was touched.");
    process.exit(2);
  }

  console.log("\nAll pre-flight checks passed.");
  if (DRY_RUN) { console.log("DRY RUN — stopping here. Nothing was touched."); return; }

  // ── restart ────────────────────────────────────────────────────────────────
  console.log("\nRestarting scheduled task " + TASK + " …");
  const ps = "Stop-ScheduledTask -TaskName " + TASK + "; Start-Sleep -Seconds 3; Start-ScheduledTask -TaskName " + TASK;
  try {
    if (HOST === "localhost" || HOST === "127.0.0.1") {
      execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
    } else {
      console.log("  remote host — run this on the box itself, or via ssh:");
      console.log('    ssh <user>@' + HOST + ' "powershell -NoProfile -Command \\"' + ps + '\\""');
      console.log("  Refusing to shell out to ssh from here so credentials stay out of this script.");
      process.exit(3);
    }
  } catch (e) {
    console.log("  restart command failed: " + e.message);
    process.exit(4);
  }

  // ── verify it came back, and that it came back BETTER ──────────────────────
  console.log("\nWaiting for the bridge to report …");
  const started = Date.now();
  let reconnected = false;
  while (Date.now() - started < RECONNECT_TIMEOUT_MS) {
    await sleep(10000);
    try {
      const h = await get("/api/mt5/health?account=" + encodeURIComponent(ACCOUNT));
      if (h.connected) {
        console.log("  reconnected after " + Math.round((Date.now() - started) / 1000) + "s");
        reconnected = true;
        break;
      }
    } catch (e) { /* server may be mid-refresh */ }
  }
  if (!reconnected) {
    console.log("  BRIDGE HAS NOT REPORTED. Check the bridge log before doing anything else.");
    process.exit(5);
  }

  console.log("\nWaiting for the first candle push to confirm the new bar count …");
  const pushStart = Date.now();
  while (Date.now() - pushStart < RECONNECT_TIMEOUT_MS) {
    await sleep(15000);
    try {
      const c = await get("/api/mt5/candles");
      const gold = c.sources && c.sources.gold;
      if (gold && gold.bars && gold.bars.d1) {
        console.log("  daily bars now: " + gold.bars.d1
          + (gold.bars.d1 >= 600 ? "   <-- 600-bar change is live" : "   (still the old count)"));
        break;
      }
    } catch (e) { /* keep waiting */ }
  }

  const after = await get("/api/mt5/positions").catch(() => ({ positions: [] }));
  console.log("\nPositions after restart: " + (after.positions || []).length
    + " (was " + positions.length + ")");
  for (const p of after.positions || []) {
    console.log("  " + p.symbol + " " + p.type + " " + p.volume + "  SL " + p.sl + "  TP " + p.tp + "  P/L " + p.profit);
  }
  console.log("\nDone. No trade was closed and no SL/TP was modified by this script.");
})().catch(e => { console.error("FAILED: " + e.message); process.exit(1); });
