#!/usr/bin/env node
/**
 * medic_boundary_guard.cjs — proves an autonomous run did not narrow the firing set.
 *
 * WRITTEN DISABLED AND UNWIRED, ON PURPOSE. Nothing schedules it, nothing calls it,
 * and it cannot halt a task or send a Telegram message unless it is given --arm.
 * Without --arm it prints its verdict and exits; that is the state it ships in, and
 * the operator arms it in person after reading the diff.
 *
 * WHY IT EXISTS
 * CLAUDE.md carries a LOCKED rule set 2026-09-18: never stop, pause, throttle, clamp
 * or block any asset or any trade, and no change may reduce the firing set. A 24/7
 * medic loop is the one thing that could violate that while nobody is watching. An
 * instruction in an agent prompt can be skipped by the agent; an assertion in a script
 * cannot. This is the mechanical half of that rule.
 *
 * WHAT IT CHECKS, and nothing else:
 *   1. /api/signals — per asset, the SIGNAL and the CONFIDENCE. A confidence that fell
 *      or a signal that flipped TO WAIT is the measurable form of "the firing set got
 *      smaller".
 *   2. SHA-256 of the files that decide whether a trade happens. ANY change is a
 *      breach, including a change that looks safe: the guard's job is to notice, not
 *      to judge.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not fix anything, it does not revert anything, and it never touches a trade.
 * On a breach it stops the loop and tells a human. Reverting a file automatically is
 * how a guard becomes the thing that needs guarding.
 *
 *   node tasks/medic_boundary_guard.cjs --before          capture the pre-run state
 *   node tasks/medic_boundary_guard.cjs --after           compare, print the verdict
 *   node tasks/medic_boundary_guard.cjs --after --arm     ...and halt + alert on breach
 *   node tasks/medic_boundary_guard.cjs --selftest        prove the detector detects
 *
 * EXIT CODES. 0 clean, 1 BREACH, 2 COULD NOT EVALUATE. Two is not a pass: a caller
 * that treats "I could not read the server" as "nothing changed" is the failure this
 * project keeps rediscovering, so the third code exists to make that impossible to
 * write by accident.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STATE = path.join(ROOT, "tasks", "logs", "medic_boundary_state.json");
const LOG = path.join(ROOT, "tasks", "logs", "medic_boundary_guard.txt");
const SERVER = process.env.SMARTENTRY_HOST || "http://127.0.0.1:3001";
const ASSETS = ["btc", "gold", "spx"];

// The files that decide whether a trade happens. Hashed whole - a diff is a breach
// even when the diff looks harmless, because "looks harmless" is a judgement and this
// script does not make judgements.
const WATCHED = [
  "server/strategy_settings.json",
  "server/learning.json",
  "mt5_bridge.py",
  "tasks/fvg_executor.py",
];

const ARMED = process.argv.includes("--arm");
const MEDIC_TASK = "SmartEntry Agent Medic";

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try { fs.appendFileSync(LOG, stamped + "\n"); } catch (_) { /* never fatal */ }
}

function getJson(urlPath, timeoutMs = 15000) {
  return new Promise(resolve => {
    const req = http.get(SERVER + urlPath, { timeout: timeoutMs }, res => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ _error: "HTTP " + res.statusCode });
        try { resolve(JSON.parse(body)); } catch (e) { resolve({ _error: "bad JSON: " + e.message }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ _error: "timeout" }); });
    req.on("error", e => resolve({ _error: e.message }));
  });
}

function hashFile(rel) {
  const full = path.join(ROOT, rel);
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex").slice(0, 32);
  } catch (e) {
    // ABSENT is recorded as its own value, not as null. A file that disappears between
    // the two snapshots must read as a change, and null == null would read as "same".
    return "ABSENT:" + (e.code || "ERR");
  }
}

async function snapshot() {
  const sig = await getJson("/api/signals");
  if (sig._error) return { _error: "signals unreadable: " + sig._error };
  const signals = {};
  for (const a of ASSETS) {
    const row = sig[a];
    if (!row) return { _error: "signals payload has no '" + a + "'" };
    const conf = Number(row.confidence);
    if (!Number.isFinite(conf)) return { _error: "confidence for " + a + " is not a number" };
    signals[a] = { signal: String(row.signal), confidence: conf, setup: String(row.setup) };
  }
  const hashes = {};
  for (const rel of WATCHED) hashes[rel] = hashFile(rel);
  return { at: new Date().toISOString(), signals, hashes };
}

function compare(before, after) {
  const breaches = [];
  for (const a of ASSETS) {
    const b = before.signals[a], n = after.signals[a];
    // A DROP is a breach. A RISE is not - the LOCKED rule says the firing set may
    // grow. Equality is the common case and says nothing.
    if (n.confidence < b.confidence) {
      breaches.push(`${a}: confidence FELL ${b.confidence} -> ${n.confidence}`);
    }
    if (n.signal === "WAIT" && b.signal !== "WAIT") {
      breaches.push(`${a}: signal flipped ${b.signal} -> WAIT`);
    }
  }
  for (const rel of WATCHED) {
    if (before.hashes[rel] !== after.hashes[rel]) {
      breaches.push(`${rel}: CHANGED (${before.hashes[rel]} -> ${after.hashes[rel]})`);
    }
  }
  return breaches;
}

function telegram(text) {
  // Reads the token from keys.env at call time and never prints it. The server's own
  // /api/agent/notify swallows send failures (`.catch(() => {})`), so a breach alert
  // routed through it could fail silently - which is exactly the case this must not
  // have. This posts to Telegram directly and reports what Telegram said.
  const envPath = path.join(ROOT, "keys.env");
  let token = "", chat = "";
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (m[1] === "TELEGRAM_TOKEN") token = m[2].trim();
      if (m[1] === "TELEGRAM_CHAT_ID") chat = m[2].trim();
    }
  } catch (e) { return "keys.env unreadable: " + e.message; }
  if (!token || !chat) return "no TELEGRAM_TOKEN/CHAT_ID in keys.env";
  try {
    const out = execFileSync("curl", [
      "-s", "--max-time", "20",
      "-X", "POST", `https://api.telegram.org/bot${token}/sendMessage`,
      "--data-urlencode", `chat_id=${chat}`,
      "--data-urlencode", `text=${text}`,
    ], { encoding: "utf8" });
    const ok = /"ok":\s*true/.test(out);
    return ok ? "delivered" : "telegram refused: " + out.slice(0, 160);
  } catch (e) { return "send failed: " + e.message; }
}

function haltLoop() {
  // Stops the medic task and nothing else. It does not stop the bridge, the
  // executors, the server or the watchdog - halting trading is itself a breach of
  // the LOCKED rule, so the guard may only silence the autonomous loop.
  try {
    execFileSync("schtasks", ["/end", "/tn", MEDIC_TASK], { stdio: "ignore" });
    execFileSync("schtasks", ["/change", "/tn", MEDIC_TASK, "/disable"], { stdio: "ignore" });
    return "medic loop disabled";
  } catch (e) { return "could not disable the medic task: " + e.message; }
}

function selftest() {
  // A guard nobody has seen fail is a guard nobody has seen work. Every case below is
  // one the real thing must catch.
  const base = {
    at: "t0",
    signals: { btc: { signal: "BUY", confidence: 88, setup: "MOMENTUM" },
               gold: { signal: "WAIT", confidence: 40, setup: "MOMENTUM" },
               spx: { signal: "WAIT", confidence: 0, setup: "BB_SQUEEZE_WATCH" } },
    hashes: { "server/strategy_settings.json": "aaa", "server/learning.json": "bbb",
              "mt5_bridge.py": "ccc", "tasks/fvg_executor.py": "ddd" },
  };
  const clone = () => JSON.parse(JSON.stringify(base));
  const cases = [];

  cases.push(["identical -> clean", compare(base, clone()).length === 0]);

  let x = clone(); x.signals.btc.confidence = 70;
  cases.push(["confidence drop -> breach", compare(base, x).length === 1]);

  x = clone(); x.signals.btc.confidence = 95;
  cases.push(["confidence RISE -> clean (growth is allowed)", compare(base, x).length === 0]);

  x = clone(); x.signals.btc.signal = "WAIT";
  cases.push(["flip to WAIT -> breach", compare(base, x).some(b => /WAIT/.test(b))]);

  x = clone(); x.signals.gold.signal = "BUY";
  cases.push(["WAIT -> BUY -> clean", compare(base, x).length === 0]);

  x = clone(); x.hashes["server/strategy_settings.json"] = "zzz";
  cases.push(["settings hash change -> breach", compare(base, x).length === 1]);

  x = clone(); x.hashes["mt5_bridge.py"] = "ABSENT:ENOENT";
  cases.push(["watched file vanishes -> breach", compare(base, x).length === 1]);

  x = clone(); x.signals.btc.confidence = 70; x.hashes["server/learning.json"] = "qqq";
  cases.push(["two problems -> two breaches", compare(base, x).length === 2]);

  let bad = 0;
  for (const [name, pass] of cases) {
    console.log("  " + (pass ? "ok  " : "FAIL") + "  " + name);
    if (!pass) bad++;
  }
  console.log(bad ? `\nSELFTEST FAILED: ${bad} case(s)` : "\nSELFTEST PASSED: all cases");
  return bad ? 1 : 0;
}

(async function main() {
  if (process.argv.includes("--selftest")) process.exit(selftest());

  const mode = process.argv.includes("--before") ? "before"
             : process.argv.includes("--after") ? "after" : null;
  if (!mode) {
    console.log("usage: --before | --after [--arm] | --selftest   (see the header)");
    process.exit(2);
  }

  const snap = await snapshot();
  if (snap._error) {
    log(`COULD NOT EVALUATE (${mode}): ${snap._error}`);
    log("exit 2 - this is NOT a pass. The caller must treat it as unverified.");
    process.exit(2);
  }

  if (mode === "before") {
    try { fs.writeFileSync(STATE, JSON.stringify(snap, null, 2)); }
    catch (e) { log("could not write the before-state: " + e.message); process.exit(2); }
    log(`before: ${ASSETS.map(a => `${a} ${snap.signals[a].signal}/${snap.signals[a].confidence}`).join("  ")}`);
    process.exit(0);
  }

  let before;
  try { before = JSON.parse(fs.readFileSync(STATE, "utf8")); }
  catch (e) { log("no usable before-state (" + e.message + ")"); process.exit(2); }

  const breaches = compare(before, snap);
  log(`after:  ${ASSETS.map(a => `${a} ${snap.signals[a].signal}/${snap.signals[a].confidence}`).join("  ")}`);

  if (!breaches.length) {
    log("CLEAN - the firing set did not shrink and no watched file changed.");
    process.exit(0);
  }

  log("BREACH - the autonomous run narrowed the firing set or touched a watched file:");
  for (const b of breaches) log("   - " + b);

  if (!ARMED) {
    log("NOT ARMED: no task was halted and no alert was sent. Re-run with --arm to enable that.");
    process.exit(1);
  }
  log("armed: " + haltLoop());
  log("armed: telegram " + telegram(
    "SmartEntry BOUNDARY BREACH - the autonomous medic loop narrowed the firing set or "
    + "changed a trading-path file. The loop has been disabled. Findings:\n- "
    + breaches.join("\n- ")));
  process.exit(1);
})();
