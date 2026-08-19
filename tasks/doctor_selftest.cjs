#!/usr/bin/env node
// Force every doctor check to fire, and prove it says the right thing when it does.
//
// WHY THIS EXISTS
// On a healthy fleet tasks/doctor.cjs prints almost nothing, and "no findings" is
// indistinguishable from "never ran". That silence has already hidden real defects:
//
//   - The encoding check's first version reported all eight dashboard pages clean while
//     six were corrupted. It matched the Latin-1 mis-decode sequence; the damage was
//     cp1252. A clean report from an untested detector is worth nothing.
//   - The ghost/orphan reconciliation check needed a WARM position cache to be correct,
//     which only shows up if you exercise it against a young server.
//   - checkMarketJobs only fires on a day something has already gone wrong, so its own
//     comment says a check never seen to fire is not a verified check.
//
// So this drives each check against fabricated bad state and asserts the finding appears
// with the right severity and box. It is the doctor for the doctor.
//
// SAFETY
// Reads and writes NOTHING in the repo. Every file-reading check is pointed at a scratch
// directory under the OS temp dir, and every HTTP check at a stub server on an ephemeral
// port. It never touches localhost:3001, never runs a remedy, and never calls diagnose().
// Nothing here feeds a gate, a threshold, confidence or sizing.
//
//   node tasks/doctor_selftest.cjs           run all cases
//   node tasks/doctor_selftest.cjs --verbose also print each finding
// Exit 0 = every case behaved, 1 = at least one check did not fire or fired wrongly.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const doctor = require("./doctor.cjs");
const VERBOSE = process.argv.includes("--verbose");

const results = [];
function check(name, expectation, findings) {
  // A case passes only if the EXPECTED finding is present. Extra findings are reported
  // rather than failed: a scratch root legitimately triggers several "missing file"
  // branches at once, and failing on those would make the harness fight itself.
  const hit = findings.find(f =>
    (!expectation.severity || f.severity === expectation.severity) &&
    (!expectation.box || f.box === expectation.box) &&
    expectation.match.test(f.what + " " + f.why));
  results.push({ name, ok: Boolean(hit), expectation, findings, hit });
  const mark = hit ? "PASS" : "FAIL";
  console.log("  [" + mark + "] " + name);
  if (!hit) {
    console.log("         expected " + (expectation.severity || "any") + "/" +
      (expectation.box || "any") + " matching " + expectation.match);
    console.log("         got: " + (findings.length
      ? findings.map(f => "[" + f.severity + "] " + f.box + ": " + f.what).join("\n              ")
      : "(no findings at all)"));
  } else if (VERBOSE) {
    console.log("         -> [" + hit.severity + "] " + hit.box + ": " + hit.what);
    console.log("            fix: " + hit.remedy);
  }
}

// Run one check function in isolation. Resetting around every case is what keeps the
// findings array from accumulating across cases and matching the wrong one.
async function isolate(fn) {
  doctor._reset();
  await fn();
  return doctor._findings().slice();
}

// ── scratch root ────────────────────────────────────────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-selftest-"));
const put = (rel, content) => {
  const full = path.join(SCRATCH, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
};
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();

// ── stub server, so the HTTP checks can be handed any state at all ──────────
// checkBox already takes a base URL, which is the only reason this is possible without
// touching the real server. Routes not in the map answer 200 {} so the check follows its
// normal path instead of tripping the unreachable branch.
function stubServer(routes) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const key = req.url.split("?")[0];
      const body = Object.prototype.hasOwnProperty.call(routes, key) ? routes[key] : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: "http://127.0.0.1:" + server.address().port });
    });
  });
}
const close = ({ server }) => new Promise(r => server.close(r));

async function withStub(routes, fn) {
  const stub = await stubServer(routes);
  try { return await fn(stub.base); } finally { await close(stub); }
}

const OK_STATUS = { startedAt: hoursAgo(5) };   // old enough that the cache counts as warm

async function main() {
  console.log("DOCTOR SELF-TEST - forcing every check to fire");
  console.log("scratch: " + SCRATCH + "\n");

  // ── checkBox: the trading-critical branches ──────────────────────────────
  console.log("checkBox");

  check("server unreachable -> RED",
    { severity: "RED", box: "box", match: /server unreachable/i },
    await isolate(() => doctor.checkBox("box", "http://127.0.0.1:1", true)));

  check("open position with NO broker-side stop -> RED",
    { severity: "RED", box: "box", match: /NO broker-side stop/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/mt5/positions": { positions: [{ ticket: 1, symbol: "XAUUSD", type: "BUY", volume: 0.01, sl: 0 }] },
    }, base => doctor.checkBox("box", base, true))));

  check("settingsError -> RED (running on built-in defaults)",
    { severity: "RED", box: "box", match: /BUILT-IN DEFAULTS/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/strategy-settings": { settingsError: "ENOENT strategy_settings.json", confidenceThreshold: 70 },
    }, base => doctor.checkBox("box", base, true))));

  check("circuit breaker open -> RED",
    { severity: "RED", box: "box", match: /TRADING HALTED/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/risk-status": { halted: true, haltReason: "3 consecutive losses" },
    }, base => doctor.checkBox("box", base, true))));

  check("2 of 3 consecutive losses -> AMBER",
    { severity: "AMBER", box: "box", match: /consecutive losses/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/risk-status": { halted: false, consecutiveLosses: 2 },
    }, base => doctor.checkBox("box", base, true))));

  // The real 2026-08-18 state on the VPS. It read as the same AMBER as 2 of 3, saying
  // "one more loss halts this box", when the threshold was already met and the only
  // thing that re-evaluates it is a trade attempt that all-WAIT signals never make.
  check("AT the limit with halted:false -> RED, not the same AMBER as one short",
    { severity: "RED", box: "box", match: /AT the limit/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/risk-status": { halted: false, consecutiveLosses: 3,
        accounts: { A: { config: { maxConsecLosses: 3 } } } },
    }, base => doctor.checkBox("box", base, true))));

  check("the limit is read from the box's config, not assumed to be 3",
    { severity: "AMBER", box: "box", match: /4 consecutive losses of 5/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/risk-status": { halted: false, consecutiveLosses: 4,
        accounts: { A: { config: { maxConsecLosses: 5 } } } },
    }, base => doctor.checkBox("box", base, true))));

  // THE GUARD. Two losses against a limit of 5 is three short — reporting it would
  // train the reader to skim past the streak that actually matters.
  const headroom = await isolate(() => withStub({
    "/api/status": OK_STATUS,
    "/api/risk-status": { halted: false, consecutiveLosses: 2,
      accounts: { A: { config: { maxConsecLosses: 5 } } } },
  }, base => doctor.checkBox("box", base, true)));
  const falseStreak = headroom.find(f => /consecutive losses/i.test(f.what));
  results.push({ name: "a streak with headroom is silent", ok: !falseStreak });
  console.log("  [" + (falseStreak ? "FAIL" : "PASS")
    + "] a streak with headroom is SILENT (guard, not finding)");

  check("healer check failing -> RED",
    { severity: "RED", box: "box", match: /healer check FAILING/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/healer": { checks: { priceFreshness: { ok: false, detail: "BTC 41m stale" } } },
    }, base => doctor.checkBox("box", base, true))));

  check("only 1 of 2 bridges reporting -> RED",
    { severity: "RED", box: "box", match: /of 2 expected bridges/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/healer": { checks: { mt5Bridge: { ok: true, detail: "1/2 bridges reporting" } } },
    }, base => doctor.checkBox("box", base, true))));

  check("job FAILING -> RED",
    { severity: "RED", box: "box", match: /job Weekly Review: FAILING/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/ai-work": { jobs: [{ label: "Weekly Review", verdict: "FAILING", detail: "no output for 7 days" }], totals: {} },
    }, base => doctor.checkBox("box", base, true))));

  check("unreviewed AI proposals -> AMBER",
    { severity: "AMBER", box: "box", match: /nobody has decided/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/ai-work": { jobs: [], totals: { unreviewed: 12 } },
    }, base => doctor.checkBox("box", base, true))));

  check("proposals citing things that do not resolve -> AMBER",
    { severity: "AMBER", box: "box", match: /do not resolve/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/ai-work": { jobs: [], totals: { proposalsWithBrokenRefs: 4 } },
    }, base => doctor.checkBox("box", base, true))));

  // GHOST: journal says open, broker does not. The -$441.84 case.
  check("GHOST - journal OPEN, broker does not hold it -> RED",
    { severity: "RED", box: "box", match: /the broker does not hold/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/mt5/positions": { positions: [{ ticket: 999, symbol: "BTCUSD", type: "BUY", volume: 0.01, sl: 50000 }] },
      "/api/journal": { journal: [{ ticket: 111, symbol: "XAUUSD", direction: "BUY", status: "OPEN" }] },
    }, base => doctor.checkBox("box", base, true))));

  // ORPHAN: broker holds a position nothing in this system is managing.
  check("ORPHAN - broker position the journal does not know -> RED",
    { severity: "RED", box: "box", match: /journal does not know about/i },
    await isolate(() => withStub({
      "/api/status": OK_STATUS,
      "/api/mt5/positions": { positions: [{ ticket: 777, symbol: "BTCUSD", type: "SELL", volume: 0.02, sl: 70000 }] },
      "/api/journal": { journal: [{ ticket: 777, symbol: "BTCUSD", direction: "SELL", status: "CLOSED", pnl: -3 }] },
    }, base => doctor.checkBox("box", base, true))));

  // THE GUARD, not the finding. A cold cache must NOT be reported as every position
  // ghosting at once - this is the false RED the check was built to avoid, so the
  // assertion is that nothing fires.
  const coldCache = await isolate(() => withStub({
    "/api/status": { startedAt: new Date().toISOString() },   // just booted
    "/api/mt5/positions": { positions: [] },                  // not filled yet
    "/api/journal": { journal: [{ ticket: 111, symbol: "XAUUSD", direction: "BUY", status: "OPEN" }] },
  }, base => doctor.checkBox("box", base, true)));
  const falseGhost = coldCache.find(f => /broker does not hold/i.test(f.what));
  results.push({ name: "cold position cache does NOT report ghosts", ok: !falseGhost });
  console.log("  [" + (falseGhost ? "FAIL" : "PASS") + "] cold position cache does NOT report ghosts (guard, not finding)");

  // ── fleet-level ──────────────────────────────────────────────────────────
  console.log("\ncheckFleetExposure / checkParity");

  check("same symbol and direction on BOTH boxes -> AMBER",
    { severity: "AMBER", box: "fleet", match: /held on BOTH boxes/i },
    await isolate(() => doctor.checkFleetExposure([
      ["this box", { positions: [{ ticket: 1, symbol: "XAUUSD", type: "BUY", volume: 0.01 }] }],
      ["peer",     { positions: [{ ticket: 2, symbol: "XAUUSD", type: "BUY", volume: 0.01 }] }],
    ])));

  check("engine parity never recorded -> AMBER on the box that can reach its peer",
    { severity: "AMBER", box: "fleet", match: /never been recorded/i },
    await isolate(() => doctor.checkParity(true, SCRATCH)));

  // The asymmetry that matters: on the VPS this can never clear, so it must be INFO.
  // CLAUDE.md is explicit that an action item which cannot clear is worse than none.
  check("parity unrecorded on the box that CANNOT reach its peer -> INFO, not a chore",
    { severity: "INFO", box: "fleet", match: /never been recorded/i },
    await isolate(() => doctor.checkParity(false, SCRATCH)));

  put("tasks/logs/vps_parity_last.json", JSON.stringify({
    verdict: "ENGINES DIVERGE", engineDrift: 2, scalarDrift: 0, fileDrift: 1, ranAt: hoursAgo(1),
  }));
  check("engines diverge -> RED",
    { severity: "RED", box: "fleet", match: /ENGINES DIVERGE/i },
    await isolate(() => doctor.checkParity(true, SCRATCH)));

  put("tasks/logs/vps_parity_last.json", JSON.stringify({
    verdict: "ENGINES AGREE", engineDrift: 0, scalarDrift: 0, fileDrift: 0, ranAt: hoursAgo(72),
  }));
  check("parity verdict 72h stale -> AMBER",
    { severity: "AMBER", box: "fleet", match: /last confirmed/i },
    await isolate(() => doctor.checkParity(true, SCRATCH)));

  // ── the AI's capacity to work at all ─────────────────────────────────────
  console.log("\ncheckAgentQueue / checkAiCapacity");

  put("tasks/agent_queue.jsonl", JSON.stringify({ brief: "weekly", resetAt: hoursAgo(2) }) + "\n");
  check("parked brief due to resume -> AMBER, healable",
    { severity: "AMBER", box: "local", match: /due to resume/i },
    await isolate(() => doctor.checkAgentQueue(SCRATCH)));

  put("tasks/agent_queue.jsonl", JSON.stringify({ brief: "weekly", resetAt: hoursAgo(-6) }) + "\n");
  check("parked brief still waiting -> INFO, the queue working",
    { severity: "INFO", box: "local", match: /parked, waiting/i },
    await isolate(() => doctor.checkAgentQueue(SCRATCH)));

  // The 2026-08-12 failure: four claude jobs died at once behind one weekly ceiling.
  put("tasks/logs/agent_log.txt",
    "[run] morning agent\nYou've hit your weekly limit - resets Aug 13, 11am\n");
  check("limit hit WITH briefs parked -> INFO, not lost",
    { severity: "INFO", box: "local", match: /subscription limit/i },
    await isolate(() => doctor.checkAiCapacity(SCRATCH)));

  fs.rmSync(path.join(SCRATCH, "tasks", "agent_queue.jsonl"));
  check("limit hit with NOTHING parked -> AMBER, the brief was lost",
    { severity: "AMBER", box: "local", match: /nothing is parked/i },
    await isolate(() => doctor.checkAiCapacity(SCRATCH)));

  // ── the market-hour jobs ─────────────────────────────────────────────────
  console.log("\ncheckMarketJobs");

  check("no deep plan has ever been built -> AMBER, healable",
    { severity: "AMBER", box: "local", match: /has ever been built/i },
    await isolate(() => doctor.checkMarketJobs(SCRATCH)));

  put("tasks/analysis/deep-plan-latest.json", JSON.stringify({
    generatedAt: hoursAgo(48), preOpenSlot: { at: "11:45", confident: true },
  }));
  check("deep plan 48h old -> AMBER",
    { severity: "AMBER", box: "local", match: /deep plan is .* old/i },
    await isolate(() => doctor.checkMarketJobs(SCRATCH)));

  put("tasks/analysis/deep-plan-latest.json", JSON.stringify({
    generatedAt: hoursAgo(1), preOpenSlot: { at: "11:45", confident: true },
  }));
  put("tasks/logs/postclose_analysis.txt",
    "[2026-08-17 21:35:00] POST-CLOSE ANALYSIS DONE - 5 ok - 2 failed\n");
  check("post-close analysis had failed harnesses -> AMBER",
    { severity: "AMBER", box: "local", match: /failed harness/i },
    await isolate(() => doctor.checkMarketJobs(SCRATCH)));

  // THE ONE THAT MATTERS: the pre-open job firing inside a news blackout.
  check("pre-open trigger never reconciled with the computed slot -> AMBER",
    { severity: "AMBER", box: "local", match: /never been reconciled/i },
    await isolate(() => doctor.checkMarketJobs(SCRATCH)));

  put("tasks/logs/reschedule_preopen.txt",
    "[2026-08-17 22:00:00] NO CHANGE - schtasks refused, trigger left at previous time\n");
  check("the attempt to move the pre-open trigger FAILED -> AMBER",
    { severity: "AMBER", box: "local", match: /failed/i },
    await isolate(() => doctor.checkMarketJobs(SCRATCH)));

  put("tasks/logs/reschedule_preopen.txt",
    "[2026-08-10 22:00:00] moved 'SmartEntryPreOpen' to 11:45\n");
  check("trigger set BEFORE the current plan was built -> AMBER (yesterday's calendar)",
    { severity: "AMBER", box: "local", match: /before the current plan/i },
    await isolate(() => doctor.checkMarketJobs(SCRATCH)));

  put("tasks/analysis/deep-plan-latest.json", JSON.stringify({
    generatedAt: hoursAgo(1),
    preOpenSlot: { at: "11:45", confident: false, reason: "every candidate slot was blacked out" },
  }));
  put("tasks/logs/reschedule_preopen.txt",
    "[" + new Date().toISOString().slice(0, 19).replace("T", " ") + "] moved 'SmartEntryPreOpen' to 11:45\n");
  check("pre-open slot not chosen from a clean calendar -> INFO",
    { severity: "INFO", box: "local", match: /not chosen from a clean calendar/i },
    await isolate(() => doctor.checkMarketJobs(SCRATCH)));

  // ── the record itself ────────────────────────────────────────────────────
  console.log("\ncheckBackup / checkDashboardEncoding / checkLearningIntegrity");

  check("no backup log at all -> AMBER",
    { severity: "AMBER", box: "local", match: /no backup log/i },
    await isolate(() => doctor.checkBackup(SCRATCH)));

  const backupFile = put("tasks/logs/backup_log.txt", "backup ok\n");
  const old = Date.now() - 40 * 3600000;
  fs.utimesSync(backupFile, old / 1000, old / 1000);
  check("backup 40h old -> AMBER",
    { severity: "AMBER", box: "local", match: /last backup/i },
    await isolate(() => doctor.checkBackup(SCRATCH)));

  // -- the heartbeat's own coverage -----------------------------------------
  //
  // The 2026-08-19 case: healthy tick at 00:11, nothing until 04:44, and the tick that
  // ended the hole restarts everything. Both blocks read fine in isolation, which is
  // exactly why only the GAP can be the signal.
  console.log("\ncheckCoverageGaps");

  // Local 'yyyy-MM-dd HH:mm:ss', because that is what Write-Log emits and the check
  // parses it as local time on purpose.
  const stamp = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
    "-" + String(d.getDate()).padStart(2, "0") + " " + d.toTimeString().slice(0, 8);
  const tick = (minutesAgo, body) => {
    const d = new Date(Date.now() - minutesAgo * 60000);
    return ["[" + stamp(d) + "] --- ensure_running start ---",
            ...body.map(l => "[" + stamp(d) + "] " + l),
            "[" + stamp(d) + "] --- ensure_running done ---"].join("\n");
  };
  const HEALTHY = ["SERVER: up", "BRIDGE A: reporting (2s ago)", "GUARDIAN: running (1)"];
  const RESTARTED = ["TERMINAL 1: starting", "SERVER: down -- starting",
                     "BRIDGE A: not reporting -- starting", "GUARDIAN: starting",
                     "JARVIS: no window -- opening"];
  const logOf = (...ticks) => ticks.join("\n") + "\n";

  put("tasks/logs/ensure_running.txt",
    logOf(tick(300, HEALTHY), tick(290, HEALTHY), tick(20, RESTARTED), tick(10, HEALTHY)));
  check("4h+ hole followed by components restarting -> AMBER",
    { severity: "AMBER", box: "local", match: /no ensure_running tick.*had to be restarted/i },
    await isolate(() => doctor.checkCoverageGaps(SCRATCH)));

  // Same size hole, ordinary block after it: a suspended machine or a DST step, not an
  // outage. Must NOT be AMBER, or the check cries wolf twice a year.
  put("tasks/logs/ensure_running.txt",
    logOf(tick(300, HEALTHY), tick(290, HEALTHY), tick(20, HEALTHY), tick(10, HEALTHY)));
  check("same hole but nothing restarted -> INFO, not AMBER",
    { severity: "INFO", box: "local", match: /nothing needed restarting/i },
    await isolate(() => doctor.checkCoverageGaps(SCRATCH)));

  put("tasks/logs/ensure_running.txt",
    logOf(tick(40, HEALTHY), tick(30, HEALTHY), tick(20, HEALTHY), tick(10, HEALTHY)));
  const steadyTicks = await isolate(() => doctor.checkCoverageGaps(SCRATCH));
  results.push({ name: "ticks on schedule are SILENT", ok: steadyTicks.length === 0,
    expectation: { match: /silent/ }, findings: steadyTicks, hit: steadyTicks.length === 0 });
  console.log("  [" + (steadyTicks.length === 0 ? "PASS" : "FAIL") + "] ticks on schedule are SILENT");

  // An old hole is history. Reporting it forever trains you to skim past the live one.
  put("tasks/logs/ensure_running.txt",
    logOf(tick(6000, HEALTHY), tick(5000, RESTARTED), tick(20, HEALTHY), tick(10, HEALTHY)));
  const oldGap = await isolate(() => doctor.checkCoverageGaps(SCRATCH));
  const oldGapQuiet = !oldGap.some(f => f.severity === "AMBER");
  results.push({ name: "a hole older than the lookback is not re-reported", ok: oldGapQuiet,
    expectation: { match: /old/ }, findings: oldGap, hit: oldGapQuiet });
  console.log("  [" + (oldGapQuiet ? "PASS" : "FAIL") + "] a hole older than the lookback is not re-reported");

  fs.rmSync(path.join(SCRATCH, "tasks", "logs", "ensure_running.txt"));
  check("no ensure_running log at all -> AMBER",
    { severity: "AMBER", box: "local", match: /no ensure_running log/i },
    await isolate(() => doctor.checkCoverageGaps(SCRATCH)));

  // The mojibake this whole thread started with, in both mis-decode forms.
  put("dashboard/broken.html",
    "<title>SmartEntry Pro â€” System</title>ðŸŽ¯\n");
  put("dashboard/latin1.html",
    "<h1>Fleet â both boxes</h1>\n");
  check("mojibake in a served page -> AMBER (cp1252 AND Latin-1 forms)",
    { severity: "AMBER", box: "local", match: /mis-decoded text/i },
    await isolate(() => doctor.checkDashboardEncoding(path.join(SCRATCH, "dashboard"))));

  check("dashboard directory missing -> INFO, must not throw",
    { severity: "INFO", box: "local", match: /could not be scanned/i },
    await isolate(() => doctor.checkDashboardEncoding(path.join(SCRATCH, "nope"))));

  // The check that reads THIS suite's own result. Its four branches matter because the
  // whole point of scheduling the suite is that a failure surfaces without being asked for.
  console.log("\ncheckDoctorSelftest (the reporter reporting on the reporter)");

  check("self-test never run on this box -> AMBER",
    { severity: "AMBER", box: "local", match: /never been verified/i },
    await isolate(() => doctor.checkDoctorSelftest(SCRATCH)));

  // A run that died partway leaves output but no verdict line. Unknown, not good.
  put("tasks/logs/doctor_selftest_last.txt", "DOCTOR SELF-TEST\n  [PASS] something\n");
  check("output present but no verdict line -> AMBER (died mid-run)",
    { severity: "AMBER", box: "local", match: /recorded no verdict/i },
    await isolate(() => doctor.checkDoctorSelftest(SCRATCH)));

  put("tasks/logs/doctor_selftest_last.txt",
    "  36 of 39 cases behaved as specified\n"
    + "  DID NOT FIRE OR FIRED WRONGLY:\n"
    + "    - open position with NO broker-side stop -> RED\n"
    + "[selftest exit 1]\n");
  check("self-test FAILING -> AMBER naming the checks that did not fire",
    { severity: "AMBER", box: "local", match: /self-test FAILING.*36 of 39/i },
    await isolate(() => doctor.checkDoctorSelftest(SCRATCH)));

  const stFile = put("tasks/logs/doctor_selftest_last.txt",
    "  39 of 39 cases behaved as specified\n[selftest exit 0]\n");
  const stOld = Date.now() - 40 * 3600000;
  fs.utimesSync(stFile, stOld / 1000, stOld / 1000);
  check("self-test passed but 40h ago -> AMBER (the daily job has not completed)",
    { severity: "AMBER", box: "local", match: /last passed/i },
    await isolate(() => doctor.checkDoctorSelftest(SCRATCH)));

  // And the healthy case must be SILENT, or it becomes noise every single day.
  fs.utimesSync(stFile, Date.now() / 1000, Date.now() / 1000);
  const freshPass = await isolate(() => doctor.checkDoctorSelftest(SCRATCH));
  results.push({ name: "fresh passing self-test is SILENT", ok: freshPass.length === 0 });
  console.log("  [" + (freshPass.length === 0 ? "PASS" : "FAIL") +
    "] fresh passing self-test is SILENT (guard, not finding)");
  if (freshPass.length) console.log("         got: " + freshPass.map(f => f.what).join("; "));

  put("server/journal.json", JSON.stringify([
    { ticket: 1, status: "CLOSED", pnl: 12, setup: "MOMENTUM" },
    { ticket: 2, status: "CLOSED", pnl: -8, setup: "WAIT" },
  ]));
  put("server/learning.json", JSON.stringify({ setupStats: { MOMENTUM: { wins: 1, losses: 0 } } }));
  check("journal and learning disagree, with an unnamed setup -> INFO naming why",
    { severity: "INFO", box: "local", match: /closed trades, learning counts/i },
    await isolate(() => doctor.checkLearningIntegrity(SCRATCH)));

  // ── the peer, seen only through its heartbeat ─────────────────────────────
  // This is the VPS's only view of the laptop, and it was 401 for a week without anyone
  // noticing, so every branch here is one that has already failed silently in production.
  console.log("\ncheckPeerViaHeartbeat (the VPS's only view of the laptop)");

  check("no peer has ever checked in -> AMBER",
    { severity: "AMBER", box: "peer", match: /has ever checked in/i },
    await isolate(() => withStub({ "/api/peer-heartbeat": { peers: [] } },
      base => doctor.checkPeerViaHeartbeat(70, base))));

  check("heartbeat silent 40m -> RED",
    { severity: "RED", box: "peer THEMIS", match: /heartbeat silent/i },
    await isolate(() => withStub({
      "/api/peer-heartbeat": { peers: [{ box: "THEMIS", ageSeconds: 2400, state: {} }] },
    }, base => doctor.checkPeerViaHeartbeat(70, base))));

  check("peer halted -> RED",
    { severity: "RED", box: "peer THEMIS", match: /TRADING HALTED/i },
    await isolate(() => withStub({
      "/api/peer-heartbeat": { peers: [{ box: "THEMIS", ageSeconds: 120, state: { halted: true, haltReason: "3 losses" } }] },
    }, base => doctor.checkPeerViaHeartbeat(70, base))));

  check("peer bridge silent -> RED",
    { severity: "RED", box: "peer THEMIS", match: /bridge\(s\) silent/i },
    await isolate(() => withStub({
      "/api/peer-heartbeat": { peers: [{ box: "THEMIS", ageSeconds: 120, state: { bridgesSilent: ["A"] } }] },
    }, base => doctor.checkPeerViaHeartbeat(70, base))));

  // The most expensive divergence this fleet can have: two gates, one pooled journal.
  check("confidence gate DIFFERS between boxes -> RED on fleet",
    { severity: "RED", box: "fleet", match: /confidence gate DIFFERS/i },
    await isolate(() => withStub({
      "/api/peer-heartbeat": { peers: [{ box: "THEMIS", ageSeconds: 120, state: { gate: 50 } }] },
    }, base => doctor.checkPeerViaHeartbeat(70, base))));

  // ── verdict ──────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log("\n" + "=".repeat(78));
  console.log("  " + (results.length - failed.length) + " of " + results.length + " cases behaved as specified");
  if (failed.length) {
    console.log("  DID NOT FIRE OR FIRED WRONGLY:");
    for (const f of failed) console.log("    - " + f.name);
  }
  console.log("=".repeat(78));

  // Leave the scratch dir on failure so the state that broke it can be inspected.
  if (!failed.length) { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {} }
  else console.log("  scratch kept for inspection: " + SCRATCH);

  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error("doctor_selftest: " + String((err && err.stack) || err));
  process.exit(1);
});
