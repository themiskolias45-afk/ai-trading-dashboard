// THE DOCTOR — diagnose the whole fleet, name the remedy, and optionally apply the
// safe ones.
//
//   node tasks/doctor.cjs                 diagnose both boxes, change nothing
//   node tasks/doctor.cjs --heal          also run the remedies marked HEALABLE
//   node tasks/doctor.cjs --json          machine-readable, for a surface to render
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE HEALER
// There are already two things that look like this and neither is it. The auto-healer
// (server/autohealer.js) watches the DATA plane — signal freshness, price freshness,
// file presence — and it reported 8/8 GREEN through an entire day on which the weekly
// review had been dead for seven days, the morning agent was RED, the laptop booted
// without starting its bridges for 3.5 minutes with two positions open, and the backup
// was 28 hours old. None of that is data staleness, so none of it was its job. The VPS
// coverage audit does check the control plane, thoroughly, and it exists only on the
// VPS and only ever REPORTS.
//
// So the gap is not detection, it is: one view across BOTH boxes, every finding
// carrying the exact command that fixes it, and the safe subset actually executed.
// A finding with no remedy is a worry; a remedy nobody runs is a comment.
//
// SAFETY
// Diagnosis is read-only: HTTP GETs and file reads, nothing else. --heal runs ONLY
// idempotent, non-destructive commands that already run on a schedule anyway
// (ensure_running fills gaps and never kills; vps_parity --emit only records a verdict;
// the agent drain only resumes work that was already parked). It will never restart a
// server, never touch a bridge, never change a setting, and never decide a proposal.
// Anything requiring judgement is reported with its command and left for a human.
//
// RULE: nothing here feeds a gate, a threshold, confidence or sizing.

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HEAL = process.argv.includes("--heal");
const AS_JSON = process.argv.includes("--json");

// A box is unreachable rather than broken if it does not answer quickly. Kept short:
// this is a health check, and a health check that hangs is its own outage.
const HTTP_TIMEOUT_MS = 8000;

// Thresholds. Each is the point at which a human would want to know, not a guess:
// parity is expected after every deploy, the backup task runs daily, and a bridge
// reports every 60s so three missed reports is dead rather than slow.
const PARITY_STALE_HOURS  = 24;
const BACKUP_STALE_HOURS  = 26;
const BRIDGE_STALE_SEC    = 180;
const BREAKER_WARN_AT     = 2;   // of 3 — one more loss halts the box

function get(url) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: HTTP_TIMEOUT_MS }, res => {
      let body = "";
      res.on("data", chunk => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ error: `HTTP ${res.statusCode}` });
        // A 401 parses cleanly and a JSON error body reads as success to anything that
        // only checks for a thrown exception, so the status code is checked first.
        try { resolve({ data: JSON.parse(body) }); }
        catch (e) { resolve({ error: "unparseable response" }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.on("error", e => resolve({ error: e.message }));
  });
}

function readEnv(key) {
  try {
    const line = fs.readFileSync(path.join(ROOT, "keys.env"), "utf8")
      .split(/\r?\n/).find(l => l.startsWith(key + "="));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch (e) { return null; }
}

function ageHours(ms) { return (Date.now() - ms) / 3600000; }
function human(h) {
  if (!Number.isFinite(h)) return "unknown";
  if (h < 1) return Math.round(h * 60) + "m";
  if (h < 48) return h.toFixed(1) + "h";
  return (h / 24).toFixed(1) + "d";
}

const findings = [];
/**
 * @param remedy  the EXACT command a human would run. Never a description of one:
 *                "investigate the bridge" is what this tool exists to replace.
 * @param heal    a [cmd, args] pair, only for remedies that are idempotent and
 *                non-destructive. Anything needing judgement stays null.
 */
function finding(severity, box, what, why, remedy, heal = null) {
  findings.push({ severity, box, what, why, remedy, healable: Boolean(heal), heal });
}

async function checkBox(label, base, isLocal) {
  const status = await get(base + "/api/status");
  if (status.error) {
    finding("RED", label, `server unreachable (${status.error})`,
      "every other check on this box is unanswerable, and on the VPS this is the box that trades",
      isLocal ? "powershell -File tasks\\ensure_running.ps1"
              : "ssh the VPS and run: powershell -File C:\\ai-trading-dashboard\\tasks\\ensure_running.ps1",
      isLocal ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                                path.join(ROOT, "tasks", "ensure_running.ps1")]] : null);
    return null;
  }

  const [settings, risk, healer, work] = await Promise.all([
    get(base + "/api/strategy-settings"),
    get(base + "/api/risk-status"),
    get(base + "/api/healer"),
    get(base + "/api/ai-work"),
  ]);

  if (settings.data && settings.data.settingsError) {
    finding("RED", label, "running on BUILT-IN DEFAULTS, not the saved config",
      `settingsError: ${settings.data.settingsError}. Position sizing and the gate are ` +
      "not what the saved file says, which has silently turned fixed 0.01 lots into " +
      "full risk-based sizing before",
      "fix or restore server/strategy_settings.json on that box, then restart the server");
  }

  if (risk.data) {
    if (risk.data.halted) {
      finding("RED", label, `TRADING HALTED — ${risk.data.haltReason || "circuit breaker open"}`,
        "no trade can be taken on this box until the breaker is reset",
        "review the losses first, then reset the breaker deliberately");
    } else if ((risk.data.consecutiveLosses || 0) >= BREAKER_WARN_AT) {
      finding("AMBER", label, `${risk.data.consecutiveLosses} consecutive losses of 3`,
        "one more loss halts this box; worth knowing BEFORE it happens rather than after",
        "no action required — this is a warning, not a fault");
    }
  }

  if (healer.data && healer.data.checks) {
    for (const [name, check] of Object.entries(healer.data.checks)) {
      if (check && check.ok === false) {
        finding("RED", label, `healer check FAILING: ${name}`,
          check.detail || "no detail given",
          `curl -X POST ${base}/api/healer/heal`);
      }
    }
    const bridge = healer.data.checks.mt5Bridge;
    if (bridge && bridge.ok && /(\d+)\/(\d+)/.test(bridge.detail || "")) {
      const [, live, expected] = bridge.detail.match(/(\d+)\/(\d+)/);
      if (Number(live) < Number(expected)) {
        finding("RED", label, `only ${live} of ${expected} expected bridges reporting`,
          "a silent bridge means this box is not trading and not managing open positions",
          isLocal ? "powershell -File tasks\\ensure_running.ps1"
                  : "on the VPS: powershell -File C:\\ai-trading-dashboard\\tasks\\ensure_running.ps1",
          isLocal ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                                    path.join(ROOT, "tasks", "ensure_running.ps1")]] : null);
      }
    }
  }

  if (work.data && Array.isArray(work.data.jobs)) {
    for (const job of work.data.jobs) {
      if (["FAILING", "NO SCHEDULED TASK"].includes(job.verdict)) {
        finding("RED", label, `job ${job.label}: ${job.verdict}`, job.detail || "",
          `inspect ${job.lastFile || job.script}`);
      } else if (job.verdict === "REPORTS RED") {
        finding("AMBER", label, `job ${job.label} reports RED`, job.detail || "",
          `inspect ${job.lastFile || job.script}`);
      } else if (job.verdict === "STALE") {
        finding("AMBER", label, `job ${job.label} is STALE`, job.detail || "",
          `check the scheduled task for ${job.script}`);
      }
    }
    const totals = work.data.totals || {};
    if (totals.unreviewed > 0) {
      finding("AMBER", label, `${totals.unreviewed} AI proposal(s) nobody has decided`,
        "an agent whose correct call goes unread costs exactly what a failing agent costs; " +
        "one such proposal called a -$99.10 loss two days before it closed",
        "node tasks/ai_decide.cjs --list   then   node tasks/ai_decide.cjs <id> implemented|rejected|ignored \"why\"");
    }
    if (totals.proposalsWithBrokenRefs > 0) {
      finding("AMBER", label, `${totals.proposalsWithBrokenRefs} proposal(s) cite things that do not resolve`,
        "sound reasoning earns trust that bad citations spend — these cannot be followed as written",
        "node tasks/ai_decide.cjs --list  and check the citations block before acting");
    }
  }

  return { settings: settings.data, risk: risk.data };
}

function checkParity() {
  const file = path.join(ROOT, "tasks", "logs", "vps_parity_last.json");
  let record = null;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { record = null; }
  const healCmd = ["node", [path.join(ROOT, "tasks", "vps_parity.cjs"), "--emit"]];

  if (!record) {
    finding("AMBER", "fleet", "engine parity has never been recorded",
      "nothing has confirmed the two boxes run the same engine, so any number pooling " +
      "them is unattributable",
      "node tasks/vps_parity.cjs --emit", healCmd);
    return;
  }
  if (record.verdict !== "ENGINES AGREE") {
    finding("RED", "fleet", `engine parity: ${record.verdict}`,
      `engineDrift=${record.engineDrift} scalarDrift=${record.scalarDrift} fileDrift=${record.fileDrift}. ` +
      "The two boxes admit different trades from identical bars",
      "node tasks/vps_parity.cjs   and reconcile before trusting any pooled number");
    return;
  }
  const age = ageHours(Date.parse(record.ranAt));
  if (age > PARITY_STALE_HOURS) {
    finding("AMBER", "fleet", `engine parity last confirmed ${human(age)} ago`,
      "the verdict is stale, and it is only meaningful right after a deploy. Note a plain " +
      "run records NOTHING — the --emit flag is what clears this",
      "node tasks/vps_parity.cjs --emit", healCmd);
  }
}

function checkAgentQueue() {
  const file = path.join(ROOT, "tasks", "agent_queue.jsonl");
  let jobs = [];
  try {
    jobs = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return; }              // no queue file is the healthy default
  if (!jobs.length) return;

  const due = jobs.filter(j => !j.resetAt || Date.parse(j.resetAt) <= Date.now());
  if (due.length) {
    finding("AMBER", "local", `${due.length} parked agent brief(s) are due to resume`,
      "these are briefs a subscription limit interrupted; they are held, not lost, but " +
      "nothing has resumed them",
      "python claude_agent.py drain",
      ["python", [path.join(ROOT, "claude_agent.py"), "drain"]]);
  }
  const waiting = jobs.length - due.length;
  if (waiting > 0) {
    const next = jobs.filter(j => j.resetAt).map(j => j.resetAt).sort()[0];
    finding("INFO", "local", `${waiting} agent brief(s) parked, waiting`,
      `earliest resume ${next || "unknown"} — this is the queue working, not a fault`,
      "python claude_agent.py status");
  }
}

function checkBackup() {
  const file = path.join(ROOT, "tasks", "logs", "backup_log.txt");
  try {
    const age = ageHours(fs.statSync(file).mtimeMs);
    if (age > BACKUP_STALE_HOURS) {
      finding("AMBER", "local", `last backup ${human(age)} ago`,
        "the journal and learning files are weeks of real trades and the only record of them",
        "tasks\\backup_data.bat");
    }
  } catch (e) {
    finding("AMBER", "local", "no backup log found",
      "nothing confirms a backup has ever run on this box", "tasks\\backup_data.bat");
  }
}

/**
 * The journal and the learning engine must tell the same story about closed trades.
 * They currently do not, deliberately — a trade whose setup name was lost upstream is
 * refused rather than attributed to a phantom bucket — so this reports the gap and
 * says WHY rather than calling it a fault.
 */
function checkLearningIntegrity() {
  let journal, learning;
  try { journal = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "journal.json"), "utf8")); }
  catch (e) { return; }
  try { learning = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "learning.json"), "utf8")); }
  catch (e) { return; }

  const closed = (journal || []).filter(t => t && t.status === "CLOSED" && typeof t.pnl === "number");
  const counted = Object.values(learning.setupStats || {})
    .reduce((sum, s) => sum + (s.wins || 0) + (s.losses || 0), 0);
  if (closed.length === counted) return;

  const unnamed = closed.filter(t => !t.setup || ["WAIT", "NONE", "UNKNOWN"].includes(String(t.setup).toUpperCase()));
  finding("INFO", "local",
    `journal has ${closed.length} closed trades, learning counts ${counted}`,
    unnamed.length
      ? `${unnamed.length} closed trade(s) carry no real setup name, so updateLearning refuses ` +
        "to attribute them rather than invent a bucket. Any calibration claim must say which " +
        "of the two numbers it means"
      : "the two disagree for a reason this check cannot see — worth investigating before " +
        "quoting either number",
    "compare server/journal.json against server/learning.json");
}

(async () => {
  const peer = readEnv("PEER_SERVER_URL");
  const boxes = [["this box", "http://localhost:3001", true]];
  if (peer) boxes.push(["peer", peer, false]);

  const seen = [];
  for (const [label, base, isLocal] of boxes) seen.push([label, await checkBox(label, base, isLocal)]);

  // Cross-box comparison. A gate mismatch means the two boxes admit different trades
  // from identical bars and their journals cannot be pooled — the single most
  // expensive kind of divergence this fleet has had.
  const gates = seen.filter(([, s]) => s && s.settings).map(([label, s]) => [label, s.settings.confidenceThreshold]);
  if (gates.length === 2 && gates[0][1] !== gates[1][1]) {
    finding("RED", "fleet", `confidence gate DIFFERS: ${gates[0][0]}=${gates[0][1]} vs ${gates[1][0]}=${gates[1][1]}`,
      "the two boxes admit different trades from the same bars; pooled performance numbers " +
      "are meaningless until this is reconciled",
      "set both to the intended gate in each box's server/strategy_settings.json");
  }

  checkParity();
  checkAgentQueue();
  checkBackup();
  checkLearningIntegrity();

  const rank = { RED: 0, AMBER: 1, INFO: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  if (AS_JSON) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), findings, feedsTheGate: false }, null, 2));
  } else {
    const counts = findings.reduce((acc, f) => (acc[f.severity] = (acc[f.severity] || 0) + 1, acc), {});
    const W = 96;
    console.log("=".repeat(W));
    console.log(`  DOCTOR — ${new Date().toISOString()}`);
    console.log(`  ${counts.RED || 0} RED, ${counts.AMBER || 0} AMBER, ${counts.INFO || 0} INFO` +
                (HEAL ? "   [--heal: safe remedies WILL run]" : "   (diagnose only; --heal applies the safe ones)"));
    console.log("=".repeat(W));
    if (!findings.length) console.log("\n  Nothing to report. Both boxes healthy.\n");
    for (const f of findings) {
      console.log("");
      console.log(`  [${f.severity}] ${f.box}: ${f.what}`);
      console.log(`      why: ${f.why}`);
      console.log(`      fix: ${f.remedy}${f.healable ? "   (HEALABLE)" : ""}`);
    }
    console.log("");
    console.log("=".repeat(W));
  }

  if (HEAL) {
    const healable = findings.filter(f => f.healable);
    if (!healable.length) console.log("  --heal: nothing safely healable.");
    for (const f of healable) {
      const [cmd, args] = f.heal;
      console.log(`  healing: ${f.what}\n    running: ${cmd} ${args.join(" ")}`);
      try {
        execFileSync(cmd, args, { cwd: ROOT, timeout: 300000, stdio: "pipe", encoding: "utf8" });
        console.log("    ok");
      } catch (err) {
        // A heal that fails must be louder than one that never ran, not quieter.
        console.log(`    FAILED: ${String(err.message || err).split("\n")[0]}`);
      }
    }
    console.log("  re-run the doctor to confirm what cleared.");
  }

  // Exit code so a scheduled task can act on it: 1 means something is RED.
  process.exit(findings.some(f => f.severity === "RED") ? 1 : 0);
})();
