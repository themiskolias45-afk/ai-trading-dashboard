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
 *     1R. This paragraph used to end there, concluding the partial could never
 *     fire because "the fixed 0.01 sizing this system trades" makes half_vol 0.
 *     TRUE WHEN WRITTEN, FALSE FROM 2026-08-24, when fixedLotSize became 0.02 and
 *     half became exactly 0.01 — which IS the minimum on BTCUSD and XAUUSD, and
 *     the guard tests `<`, not `<=`. The check below no longer trusts a constant
 *     for this: it reads each symbol's real minLot and lotStep from
 *     /api/broker-specs and does the bridge's own floor-then-compare, and it
 *     treats partialCloseEnabled=false as not-splittable because the code path
 *     does not run at all then. A safety property that lives in a comment stops
 *     being one the moment the comment goes stale.
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
const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
// Which restart mechanism this box actually has. Decided in pre-flight, used at the
// restart step, so the two can never disagree about what is about to happen.
let usePidFile  = false;
let pidFromFile = null;

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

// Most routes this tool reads are in the no-login allowlist, but the broker-spec
// lookup below is session-gated like every other data route. The secret lives on
// disk next to the server, so a LOCAL run can present it; a --host run against
// another box cannot, and gets a 401 that the caller handles by falling back.
// Read once, never logged.
let SESSION_COOKIE = null;
try {
  const secret = fs.readFileSync(path.join(PROJECT_ROOT, "server", "session_secret.txt"), "utf8").trim();
  if (secret) SESSION_COOKIE = "smartentry_session=" + secret;
} catch (e) {
  // No secret readable: gated routes 401 and each caller falls back. Not fatal.
}

function get(path) {
  return new Promise((resolve, reject) => {
    const headers = SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {};
    const req = http.get({ host: HOST, port: 3001, path, headers, timeout: 10000 }, res => {
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

  // 2. Circuit breaker — reported, NOT a blocker.
  //
  // This used to refuse when the box was halted, on the reasoning that restarting into
  // a halt is pointless. It is the opposite: a halted bridge is the SAFEST thing this
  // script can restart, because a halted bridge cannot open a position at all. The
  // dangerous restart is the one it happily allows — a live bridge that might fire a
  // signal seconds after coming back.
  //
  // Worse, the refusal was circular. On 2026-08-18 the VPS was halted at 3 of 3 with a
  // 48h cooldown, the fix was a shorter cooldown in its launcher, and a launcher change
  // needs a restart to take effect — which this check refused BECAUSE the box was
  // halted. The only exit was to bypass the safety tool, which is the worst thing a
  // safety tool can teach anyone to do.
  //
  // So it is now surfaced loudly and never blocks. Everything that protects an open
  // TRADE — broker-side stops, the partial-close guard — is checked below and does
  // still block.
  if (risk.halted) {
    console.log("  NOTE  " + "box is HALTED".padEnd(42)
      + (risk.haltReason || "circuit breaker open"));
    console.log("        a halted bridge cannot open a position, so this restart is safer,");
    console.log("        not riskier. The halt itself survives the restart - it is on disk.");
  } else {
    record("not halted", true, "trading enabled");
  }

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

  // AN EMPTY LIST IS NOT THE SAME AS FLAT.
  //
  // /api/mt5/positions is populated FROM the bridge. When the bridge is not
  // reporting - the seconds after a server restart, a terminal that died, an IPC
  // stall - the route answers with an empty array, which is indistinguishable here
  // from a genuinely flat account. Caught 2026-08-27 on the VPS: this script printed
  //
  //     FAIL  bridge currently reporting   never connected yet
  //     PASS  no open positions            flat — restart is unambiguous
  //
  // for a box holding TWO positions (XAUUSD #1849093967, SP500 #1798857871). Two of
  // its own checks contradicted each other and the UNSAFE one was treated as
  // authoritative. Had the bridge been reporting to the previous server process while
  // positions momentarily read zero, "flat" would have passed and skipped the
  // broker-SL check, the partial-close check AND the --allow-open-positions gate in
  // one go - the three things that make this script safe at all.
  //
  // So an empty list only counts as flat when the bridge is CONFIRMED reporting.
  // Otherwise the state is UNKNOWN, and unknown must refuse. This can only ever make
  // the script refuse more often, never less.
  // See [[positions_read_zero_after_a_server_restart]].
  const bridgeReporting = Boolean(health && health.connected === true);
  if (positions.length === 0 && !bridgeReporting) {
    record("open positions known", false,
      "positions read EMPTY while the bridge is not reporting — that is UNKNOWN, not flat");
  } else if (positions.length === 0) {
    record("no open positions", true, "flat — bridge reporting, so the empty list can be trusted");
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
    // The partial-profit reset only bites if a position can ACTUALLY be split, which
    // is a property of the broker's volume_min and volume_step for that symbol — not
    // of a constant in this file. SP500 has a 0.1 minimum, so a 0.1-lot position has
    // never been splittable, and --max-lot 0.01 called it splittable every time.
    //
    // Fails CLOSED: if /api/broker-specs cannot be read, or does not know the symbol,
    // this falls back to the old volume > MAX_LOT comparison and says which rule it
    // used. More accurate, never more permissive.
    let specs = null;
    try {
      specs = await get("/api/broker-specs");
    } catch (e) {
      console.log("       broker-specs unavailable (" + e.message + ") — falling back to --max-lot");
    }

    const partialOff = specs && specs.partialCloseEnabled === false;
    let splitBasis = "--max-lot " + MAX_LOT;
    let splittable = oversized;

    if (partialOff) {
      splittable = [];
      splitBasis = "partialCloseEnabled is off, so take_partial_profit returns before touching anything";
    } else if (specs && specs.available && specs.symbols) {
      const unknown = [];
      splittable = positions.filter(pos => {
        const spec = specs.symbols[pos.symbol];
        const minLot  = spec && Number(spec.minLot);
        const lotStep = spec && Number(spec.lotStep);
        if (!minLot || !lotStep) { unknown.push(pos.symbol); return Number(pos.volume) > MAX_LOT; }
        // mt5_bridge.py:2133-2135, the same floor-then-compare.
        const vol  = Number(pos.volume);
        const half = Number((Math.floor(vol / 2 / lotStep) * lotStep).toFixed(8));
        return half >= minLot && half < vol;
      });
      splitBasis = unknown.length
        ? "broker minimums, except " + unknown.join(", ") + " which fell back to --max-lot"
        : "each symbol's own broker minLot/lotStep";
    }

    record("no position can be partial-closed", splittable.length === 0,
      splittable.length === 0
        ? "none can be halved — basis: " + splitBasis
        : splittable.length + " position(s) could be halved after the in-memory flag resets — basis: " + splitBasis);
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
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        "if (Get-ScheduledTask -TaskName '" + TASK.replace(/'/g, "''") + "' -ErrorAction SilentlyContinue) { 'FOUND' } else { 'MISSING' }"],
        { encoding: "utf8", timeout: 20000, windowsHide: true });
      taskFound = /FOUND/.test(out);
    } catch (e) { /* falls through to the pid-file route */ }

    if (taskFound) {
      record("restart target exists", true, "scheduled task '" + TASK + "' exists on this box");
    } else {
      // No task here — the laptop has none. Fall back to the pid the bridge recorded for
      // itself, and VERIFY it rather than trusting the file: a pid outlives the process
      // that owned it and can be recycled by anything.
      const pidFile = path.join(PROJECT_ROOT, "tasks", "logs", "bridge_" + ACCOUNT + ".pid");
      let detail = "";
      try {
        const raw = fs.readFileSync(pidFile, "utf8").trim();
        const candidate = Number(raw);
        if (!Number.isInteger(candidate) || candidate <= 0) {
          detail = "bridge_" + ACCOUNT + ".pid holds " + JSON.stringify(raw.slice(0, 40)) + ", not a pid";
        } else {
          const name = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
            "(Get-Process -Id " + candidate + " -ErrorAction SilentlyContinue).ProcessName"],
            { encoding: "utf8", timeout: 20000, windowsHide: true }).trim();
          if (!name) {
            detail = "pid " + candidate + " from bridge_" + ACCOUNT + ".pid is not running — stale file";
          } else if (!/python/i.test(name)) {
            detail = "pid " + candidate + " is '" + name + "', not python — the pid was recycled, refusing";
          } else {
            usePidFile = true;
            pidFromFile = candidate;
            detail = "bridge " + ACCOUNT + " self-recorded pid " + candidate + " (" + name + "), verified live";
          }
        }
      } catch (e) {
        detail = "no scheduled task '" + TASK + "' and no tasks/logs/bridge_" + ACCOUNT + ".pid. "
          + "This box records the pid only from the bridge's own startup, so it needs ONE manual "
          + "restart (tasks\\start_bridge_" + ACCOUNT + ".bat) before this tool can cycle it — after "
          + "that it works unattended.";
      }
      record("restart target exists", usePidFile, detail);
    }
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

/**
 * WHICH launcher starts this tag's bridge ON THIS BOX. Ask the box; never guess.
 *
 * THE DEFECT THIS CLOSES, found 2026-08-30 and caught BEFORE it was allowed to run.
 * Both restart paths below were wrong on the VPS, in different ways, and either would
 * have taken the trading bridge down:
 *
 *   PID PATH  started tasks\start_bridge_<TAG>.bat. On the VPS that file pins
 *             MT5_EXPECTED_LOGIN=25446287 - the LAPTOP's account - while the VPS trades
 *             11581419 from start_bridge_A_vps.bat. The bridge would come back and then
 *             refuse every order: alive, and placing nothing.
 *
 *   TASK PATH did Stop-ScheduledTask then Start-ScheduledTask on SmartEntryBridgeA.
 *             That task is logon-only and the VPS is headless, so the START CANNOT
 *             SUCCEED - 0x800710E0. It would stop the bridge and fail to bring it back.
 *
 * The box's own SmartEntryBridge<tag> task names the right launcher and is correct on
 * both machines: the VPS task says start_bridge_A_vps.bat, and the laptop has no bridge
 * task at all so it falls through to the plain launcher, correct there. Same resolver
 * and same reasoning as ensure_running.ps1::Get-BridgeLauncher.
 *
 * 'Prefer the _vps variant when it exists' was rejected: the laptop carries that file
 * too, so that rule would start the VPS's account on the laptop.
 */
function bridgeLauncherFor(tag) {
  const fallback = "start_bridge_" + tag + ".bat";
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "$t = Get-ScheduledTask -TaskName 'SmartEntryBridge" + tag + "' -ErrorAction Stop; "
      + "$t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const hit = /start_bridge_[A-Za-z](_vps)?\.bat/i.exec(out || "");
    if (hit) return hit[0];
  } catch (e) {
    // No such task on this box. That is the laptop's normal state, not an error.
  }
  return fallback;
}

  console.log("\nAll pre-flight checks passed.");
  if (DRY_RUN) { console.log("DRY RUN — stopping here. Nothing was touched."); return; }

  // ── restart ────────────────────────────────────────────────────────────────
  //
  // TWO MECHANISMS, because the boxes are not built the same. The VPS owns a per-bridge
  // scheduled task; the laptop has none at all — its bridges come up through
  // tasks/start_bridge_<TAG>.bat, driven by ensure_running.ps1, which never kills. So on
  // the laptop this tool had nothing to cycle and died on a task that does not exist.
  //
  // Killing by process match is NOT available as a fallback: Windows reports an EMPTY
  // CommandLine for these python processes (verified 2026-08-17 — two of them, both
  // `cmd=[]`, identical creation times, and one of the two is the shim), so "the bridge"
  // cannot be picked out of the process list. Guessing on a process that trades is not a
  // thing this script will do. The bridge therefore names itself: it writes its own pid to
  // tasks/logs/bridge_<TAG>.pid once MT5 is connected, and that file is the identity used
  // here — re-verified as a live python process before anything is signalled, because a
  // stale pid can be recycled by an unrelated program.
  if (usePidFile) {
    console.log("\nRestarting bridge " + ACCOUNT + " by recorded pid " + pidFromFile + " …");
    try {
      execFileSync("powershell", ["-NoProfile", "-Command",
        "Stop-Process -Id " + pidFromFile + " -Force -Confirm:$false"], { stdio: "inherit" });
      const launcher = bridgeLauncherFor(ACCOUNT);
      console.log("  stopped pid " + pidFromFile + "; starting tasks\\" + launcher);
      execFileSync("powershell", ["-NoProfile", "-Command",
        "Start-Process -FilePath 'cmd' -ArgumentList '/c','tasks\\" + launcher
        + "' -WorkingDirectory '" + PROJECT_ROOT.replace(/'/g, "''") + "' -WindowStyle Minimized"],
        { stdio: "inherit" });
    } catch (e) {
      console.log("  restart failed: " + e.message);
      // DO NOT GUESS THE STATE HERE. This used to print "The bridge may now be DOWN"
      // and point at start_bridge_<A>.bat. Measured 2026-08-27 on the laptop: the kill
      // failed with "Access is denied" because the bridge runs ELEVATED and this script
      // does not, so the process was never touched and the bridge was still up, still
      // pushing candles, still holding both positions. The message said the opposite of
      // the truth in the ONE direction that causes damage - it invites starting a
      // SECOND --auto bridge on an account that already has one, and two bridges on one
      // account double every order. See [[one_auto_bridge_per_account]] and
      // [[laptop_bridge_cannot_be_restarted_unelevated]].
      //
      // A failed Stop-Process almost always means NOTHING was stopped. Ask the health
      // route instead of asserting, and only ever suggest starting a bridge once the
      // route has confirmed there is none.
      let stillUp = null;
      try {
        const after = await get("/api/mt5/health?account=" + encodeURIComponent(ACCOUNT));
        stillUp = after && after.connected === true;
        if (stillUp) {
          console.log("  VERIFIED: the bridge is STILL RUNNING (last seen "
            + Math.round(after.ageMs / 1000) + "s ago). Nothing was stopped and nothing broke.");
          console.log("  NEVER start a second bridge on this account - two --auto bridges");
          console.log("  double every order. There is nothing to recover from here.");
          // Unconditional, and deliberately so. The child runs with stdio:"inherit", so
          // PowerShell's "Access is denied" goes to the CONSOLE and never reaches
          // e.message - which is only "Command failed: powershell ...". Gating the hint on
          // /denied/ therefore never fired, and the one case that needs the hint is exactly
          // this one: the process is demonstrably still alive after a kill attempt, which on
          // Windows means the signal was REFUSED, not that it missed.
          console.log("  A kill that leaves the process running means it was REFUSED. On this box the");
          console.log("  bridge runs ELEVATED, so re-run from an ADMINISTRATOR shell:");
          console.log("      node tasks/safe_bridge_restart.cjs --allow-open-positions");
        } else {
          console.log("  VERIFIED: the bridge is NOT reporting. It is safe to start exactly one");
          console.log("  with tasks\\start_bridge_" + ACCOUNT + ".bat");
        }
      } catch (healthError) {
        console.log("  Could not confirm bridge state (" + healthError.message + ").");
        console.log("  CHECK GET /api/mt5/health?account=" + ACCOUNT + " BEFORE starting anything -");
        console.log("  starting a second bridge on a live account doubles every order.");
      }
      process.exit(4);
    }
  } else {
  console.log("\nRestarting scheduled task " + TASK + " …");
  // START VIA THE TASK IS NOT SAFE ON A HEADLESS BOX, and the VPS is headless.
  //
  // This was Stop-ScheduledTask then Start-ScheduledTask on the SAME task. On the VPS
  // SmartEntryBridgeA is Interactive/AtLogOn, so the START cannot succeed - 0x800710E0,
  // ERROR_NO_INTERACTIVE_SESSION. The stop would work, the start would not, and the
  // bridge that trades would be left down with the tool reporting a restart.
  //
  // So the stop still goes through the task (it owns the process), and the START goes
  // through SmartEntryEnsureRunning - SYSTEM, boot-triggered, and the only thing on that
  // box that demonstrably CAN start a bridge. It resolves the launcher per box, so it
  // brings the bridge back on the right account. Triggering it explicitly turns a wait
  // of up to 10 minutes into a few seconds.
  //
  // If that task is absent (the laptop names its equivalent differently), fall back to
  // starting the resolved launcher directly rather than a task that cannot fire.
  const launcherTask = bridgeLauncherFor(ACCOUNT);
  const ps = "Stop-ScheduledTask -TaskName " + TASK + "; Start-Sleep -Seconds 3; "
    + "if (Get-ScheduledTask -TaskName 'SmartEntryEnsureRunning' -ErrorAction SilentlyContinue) "
    + "{ Start-ScheduledTask -TaskName 'SmartEntryEnsureRunning' } "
    + "else { Start-Process -FilePath 'cmd' -ArgumentList '/c','tasks\\" + launcherTask + "' "
    + "-WorkingDirectory '" + PROJECT_ROOT.replace(/'/g, "''") + "' -WindowStyle Minimized }";
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
