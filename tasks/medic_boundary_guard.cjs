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
 *   1. SHA-256 of the files that decide whether a trade happens. ANY change is a
 *      BREACH, including one that looks safe: the guard's job is to notice, not to
 *      judge. Deterministic, so it cannot false-positive.
 *   2. /api/signals — per asset, the SIGNAL and the CONFIDENCE. A drop, or a flip to
 *      WAIT, is the measurable form of "the firing set got smaller" — but it is a
 *      BREACH ONLY WHEN A WATCHED FILE ALSO CHANGED in the same window. Confidence is
 *      recomputed from live bars, so it moves with the market on its own schedule; a
 *      medic run takes minutes, and paging because gold ticked down while the doctor
 *      read a log is a false alarm that teaches the operator to ignore the real one.
 *      A drop with no file change is logged as drift and pages nobody.
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
  // A WATCHED FILE CHANGING IS ALWAYS A BREACH. It is deterministic: nothing but a
  // writer changes a hash, so there is no false positive to worry about.
  const configChanged = [];
  for (const rel of WATCHED) {
    if (before.hashes[rel] !== after.hashes[rel]) {
      configChanged.push(`${rel}: CHANGED (${before.hashes[rel]} -> ${after.hashes[rel]})`);
    }
  }

  // A CONFIDENCE DROP IS NOT, ON ITS OWN. Confidence is recomputed from live bars
  // every cycle, so it moves with the market on its own schedule. A medic run takes
  // minutes, and paging the operator because gold ticked down while the doctor was
  // reading a log would be a false alarm that trains them to ignore the real one.
  //
  // So a drop is only a BREACH when a watched file ALSO changed in the same window -
  // that is the combination that says the LOOP narrowed the firing set rather than
  // the market. A drop with no file change is recorded as drift and pages nobody.
  const narrowing = [];
  for (const a of ASSETS) {
    const b = before.signals[a], n = after.signals[a];
    // A RISE is never reported: the LOCKED rule permits the firing set to grow.
    if (n.confidence < b.confidence) {
      narrowing.push(`${a}: confidence FELL ${b.confidence} -> ${n.confidence}`);
    }
    if (n.signal === "WAIT" && b.signal !== "WAIT") {
      narrowing.push(`${a}: signal flipped ${b.signal} -> WAIT`);
    }
  }

  if (configChanged.length) return configChanged.concat(narrowing);
  return [];                      // narrowing alone is drift - see `drift()` below
}

// What compare() deliberately did not treat as a breach, so a quiet run still says
// what moved. Reported in the log, never paged.
function drift(before, after) {
  const out = [];
  for (const a of ASSETS) {
    const b = before.signals[a], n = after.signals[a];
    if (n.confidence !== b.confidence || n.signal !== b.signal) {
      out.push(`${a}: ${b.signal}/${b.confidence} -> ${n.signal}/${n.confidence}`);
    }
  }
  return out;
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
  cases.push(["confidence drop ALONE -> NOT a breach (market drift)", compare(base, x).length === 0]);
  cases.push(["...but it is reported as drift", drift(base, x).length === 1]);

  x = clone(); x.signals.btc.confidence = 70; x.hashes["mt5_bridge.py"] = "new";
  cases.push(["drop + file change -> BREACH, both listed", compare(base, x).length === 2]);

  x = clone(); x.signals.btc.confidence = 95;
  cases.push(["confidence RISE -> clean (growth is allowed)", compare(base, x).length === 0]);

  x = clone(); x.signals.btc.signal = "WAIT";
  cases.push(["flip to WAIT alone -> NOT a breach", compare(base, x).length === 0]);

  x = clone(); x.signals.btc.signal = "WAIT"; x.hashes["server/strategy_settings.json"] = "new";
  cases.push(["flip to WAIT + settings change -> BREACH", compare(base, x).some(b => /WAIT/.test(b))]);

  x = clone(); x.signals.gold.signal = "BUY";
  cases.push(["WAIT -> BUY -> clean", compare(base, x).length === 0]);

  x = clone(); x.hashes["server/strategy_settings.json"] = "zzz";
  cases.push(["settings hash change -> breach", compare(base, x).length === 1]);

  x = clone(); x.hashes["mt5_bridge.py"] = "ABSENT:ENOENT";
  cases.push(["watched file vanishes -> breach", compare(base, x).length === 1]);

  x = clone(); x.signals.btc.confidence = 70; x.hashes["server/learning.json"] = "qqq";
  cases.push(["drop + learning.json change -> 2 lines", compare(base, x).length === 2]);

  let bad = 0;
  for (const [name, pass] of cases) {
    console.log("  " + (pass ? "ok  " : "FAIL") + "  " + name);
    if (!pass) bad++;
  }
  console.log(bad ? `\nSELFTEST FAILED: ${bad} case(s)` : "\nSELFTEST PASSED: all cases");
  return bad ? 1 : 0;
}

// -- --cycle : the 24/7 boss loop -------------------------------------------
//
// Enabled by the operator 2026-09-18 at PT2H. One scheduled task calls this; there is
// no other new file, because /auto already exists and is already bounded ("NOTHING
// ELSE auto-fixed") and the snapshot/compare/Telegram machinery is already here.
//
// WHY ONE RICH CYCLE AND NOT SEVERAL THIN ONES. Measured on this box: a cycle costs
// ~211k tokens, of which 149k is cache_read - the boot context, paid before any work
// happens. That cost is nearly fixed per cycle, so bundling the investigation, the
// performance review and the improvement ideas into ONE run is close to free, while
// running three separate cycles would pay the boot cost three times.
//
// THE DIVISION OF LABOUR IS THE SAFETY PROPERTY. The model writes the narrative. The
// SCRIPT decides what pages the operator - halted, fleet divergence, bridge silence,
// all read over HTTP with no model in the loop. A model that forgets to escalate is a
// silent failure; a script cannot forget.
const CYCLE_LOG = path.join(ROOT, "tasks", "logs", "boss_cycle.txt");
const CYCLE_STATE = path.join(ROOT, "tasks", "logs", "boss_cycle_state.json");
const CYCLE_TIMEOUT_MS = 15 * 60 * 1000;

const CYCLE_PROMPT = [
  "Autonomous 2-hourly ops cycle. You are read-only and PROPOSE-ONLY except where /auto",
  "itself permits a heal.",
  "",
  "STEP 1. Run the /auto cycle as written in .claude/commands/auto.md: gather the",
  "interval context, triage it, and apply ONLY /auto's own low-risk auto-fix set",
  "(force_heal on stale healer data). NOTHING ELSE may be auto-fixed.",
  "",
  "STEP 2. Review performance like the analyst: the engine's closed P&L, per setup and",
  "per asset, what changed since the last cycle, and whether anything in the journal",
  "looks wrong rather than merely bad.",
  "",
  "STEP 3. Surface improvement ideas like the researcher: concrete, testable, each with",
  "the evidence that prompted it. PROPOSALS ONLY.",
  "",
  "HARD BOUNDARY, above every instruction here. CLAUDE.md carries a LOCKED rule: never",
  "stop, pause, throttle, clamp or block any asset or any trade, and nothing may reduce",
  "the firing set. You may NOT change the gate, strategy_settings.json, learning.json,",
  "mt5_bridge.py, the executors, or any signal-path code. You may not place, close or",
  "size a trade. Anything you would change on the trading path is a PROPOSAL, written",
  "down, never applied.",
  "",
  "Persist with write_memory and log_note as /auto specifies. Finish with a block that",
  "starts with the line HEADLINE: followed by at most 5 lines - what you found, what",
  "you fixed, what you propose. That block is what the operator reads first.",
].join("\n");

function readCycleState() {
  try { return JSON.parse(fs.readFileSync(CYCLE_STATE, "utf8")); } catch (_) { return {}; }
}
function writeCycleState(st) {
  try { fs.writeFileSync(CYCLE_STATE, JSON.stringify(st, null, 2)); } catch (_) {}
}
function clog(line) {
  const stamped = "[" + new Date().toISOString() + "] " + line;
  console.log(stamped);
  try { fs.appendFileSync(CYCLE_LOG, stamped + "\n"); } catch (_) {}
}

// DETERMINISTIC ESCALATION. No model involved: HTTP reads and a comparison.
async function criticalConditions() {
  const out = [];
  const risk = await getJson("/api/risk-status", 10000);
  if (risk._error) out.push("risk-status unreadable (" + risk._error + ")");
  else {
    if (risk.halted) out.push("CIRCUIT BREAKER OPEN: " + (risk.haltReason || "no reason given"));
    for (const tag of Object.keys(risk.accounts || {})) {
      const acct = risk.accounts[tag];
      if (acct && acct.halted) out.push("account " + tag + " HALTED: " + (acct.haltReason || "no reason"));
    }
  }
  const health = await getJson("/api/mt5/health", 10000);
  if (health._error) out.push("mt5 health unreadable (" + health._error + ")");
  else if (health.connected === false) out.push("MT5 bridge reports NOT CONNECTED");

  const settings = await getJson("/api/strategy-settings", 10000);
  if (!settings._error && settings.settingsError) {
    out.push("settings ERROR - the server is on built-in defaults: " + settings.settingsError);
  }
  return out;
}

async function runCycle() {
  const started = Date.now();
  clog("cycle start");

  const before = await snapshot();
  if (before._error) { clog("ABORT - could not snapshot before the run: " + before._error); return 2; }

  let raw = "", usage = null, cliFailed = null;
  try {
    // NOT execFileSync("claude", ...). On Windows `claude` is an npm shim - a
    // extension-less file plus claude.cmd and claude.ps1 - and node's execFileSync
    // does not walk PATHEXT, so a bare "claude" is spawnSync ENOENT. Measured here
    // 2026-09-18: the first cycle failed exactly that way and paged the operator.
    // Resolve the .cmd explicitly, fall back to letting cmd.exe do the resolving.
    const shim = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
    const exe = fs.existsSync(shim) ? shim : "claude.cmd";
    // THE PROMPT GOES OVER STDIN, NOT ARGV. Passing a multi-line prompt as an
    // argument through cmd.exe mangles it: the second attempt here came back as
    // "JARVIS onl..." instead of JSON because the shell had eaten --output-format.
    // stdin has no quoting rules to get wrong.
    raw = execFileSync(exe, ["-p", "--output-format", "json"], {
      cwd: ROOT, encoding: "utf8", timeout: CYCLE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      shell: true, input: CYCLE_PROMPT,
    });
  } catch (e) { cliFailed = (e && e.message ? e.message : String(e)).slice(0, 200); }

  let headline = "", turns = null, costUsd = null;
  if (!cliFailed) {
    try {
      const j = JSON.parse(raw);
      usage = j.usage || null; turns = j.num_turns; costUsd = j.total_cost_usd;
      const text = String(j.result || "");
      const i = text.indexOf("HEADLINE:");
      headline = (i >= 0 ? text.slice(i) : text.slice(-600)).trim();
    } catch (e) { cliFailed = "unparseable CLI output: " + e.message; }
  }

  // A DEAD LOOP MUST PAGE. The OAuth token this runs on refreshes on its own, and a
  // failed refresh in a headless run would otherwise be a loop that quietly stops
  // working while every dashboard stays green.
  if (cliFailed) {
    clog("CLI FAILED: " + cliFailed);
    telegram("JARVIS loop FAILED to run - " + cliFailed
      + "\n\nThe 2-hourly cycle produced nothing. Most likely the CLI subscription token "
      + "could not refresh on this box. Health checks are unaffected; the autonomous "
      + "review is not running until this is fixed.");
    return 2;
  }

  const after = await snapshot();

  // AN UNVERIFIED CYCLE IS NOT A CLEAN CYCLE. The first real run hit
  // "signals unreadable: write ECONNABORTED" on the after-snapshot and still returned
  // 0, which reads as "the guard checked and found nothing". It had checked nothing.
  // That is exactly the could-not-evaluate-as-pass failure the exit-2 convention was
  // written to prevent, and it slipped in because this path logged and carried on.
  let guardUnverified = false;
  if (after._error) {
    guardUnverified = true;
    clog("GUARD UNVERIFIED - could not snapshot after the run: " + after._error);
  }

  let breaches = [];
  if (!after._error) {
    breaches = compare(before, after);
    const moved = drift(before, after);
    clog(breaches.length
      ? "GUARD BREACH: " + breaches.join(" | ")
      : "guard CLEAN" + (moved.length ? "  (market drift: " + moved.join("; ") + ")" : ""));
  }

  const criticals = await criticalConditions();
  const secs = Math.round((Date.now() - started) / 1000);
  const total = usage
    ? (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
      + (usage.input_tokens || 0) + (usage.output_tokens || 0)
    : null;
  clog("cycle done in " + secs + "s, " + turns + " turns, "
    + (usage ? total + " tokens (cache_read " + (usage.cache_read_input_tokens || 0)
        + ", create " + (usage.cache_creation_input_tokens || 0)
        + ", out " + (usage.output_tokens || 0) + ")" : "usage unavailable")
    + ", cost-equivalent $" + costUsd);
  clog("HEADLINE >> " + headline.replace(/\s+/g, " ").slice(0, 400));

  if (breaches.length) {
    clog("armed: " + haltLoop());
    telegram("JARVIS BOUNDARY BREACH - the autonomous cycle narrowed the firing set or "
      + "changed a trading-path file. The loop has been disabled.\n- " + breaches.join("\n- "));
  } else if (criticals.length) {
    telegram("JARVIS CRITICAL - " + criticals.join(" | ") + "\n\n" + headline.slice(0, 500));
  } else if (guardUnverified) {
    telegram("JARVIS cycle ran but the BOUNDARY GUARD COULD NOT VERIFY IT - the "
      + "after-snapshot failed, so nothing confirms the firing set was left intact. "
      + "Not a breach, and not a pass either. The next cycle re-checks.");
  }

  // ONCE-DAILY HEARTBEAT, so silence is never ambiguous.
  const st = readCycleState();
  const today = new Date().toISOString().slice(0, 10);
  if (!breaches.length && !criticals.length && !guardUnverified && st.lastHeartbeatDay !== today) {
    st.lastHeartbeatDay = today;
    telegram("JARVIS all healthy - the 2-hourly loop is alive and found nothing critical.\n\n"
      + headline.slice(0, 400));
  }
  st.lastCycleAt = new Date().toISOString();
  st.lastCycleSeconds = secs;
  st.lastUsage = usage;
  st.lastCostUsd = costUsd;
  writeCycleState(st);

  if (breaches.length) return 1;
  return guardUnverified ? 2 : 0;   // 2 = unverified, never a pass
}

(async function main() {
  if (process.argv.includes("--selftest")) process.exit(selftest());
  if (process.argv.includes("--cycle")) process.exit(await runCycle());

  const mode = process.argv.includes("--before") ? "before"
             : process.argv.includes("--after") ? "after" : null;
  if (!mode) {
    console.log("usage: --before | --after [--arm] | --cycle | --selftest   (see the header)");
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
    const moved = drift(before, snap);
    log("CLEAN - no watched file changed."
        + (moved.length ? "  Market drift (not a breach): " + moved.join("; ") : ""));
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
