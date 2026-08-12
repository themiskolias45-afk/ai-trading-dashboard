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
// The position cache is bridge-populated and reads EMPTY for roughly a minute after a
// server restart, which looks identical to every position ghosting at once. Below this
// uptime, an empty broker list is treated as "not filled yet" rather than a fault.
const POSITION_CACHE_WARM_MS = 120000;

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

// Reset by diagnose() on entry rather than being local, so the check functions below
// stay readable instead of threading an accumulator through every signature. That
// makes diagnose() non-reentrant: the HTTP caller in server/index.js serialises with a
// single in-flight promise for exactly this reason, and two concurrent callers would
// otherwise interleave into one list.
let findings = [];
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

  const [settings, risk, healer, work, positions, journal] = await Promise.all([
    get(base + "/api/strategy-settings"),
    get(base + "/api/risk-status"),
    get(base + "/api/healer"),
    get(base + "/api/ai-work"),
    get(base + "/api/mt5/positions"),
    get(base + "/api/journal?limit=100"),
  ]);

  // The worst state this system can be in, and nothing anywhere reported it. A stop
  // that is not ON THE BROKER does not exist: the bridge can die, the server can be
  // restarted, the machine can lose power, and only a broker-side SL survives all
  // three. safe_bridge_restart.cjs already refuses to act without this check; the
  // doctor had no equivalent, so an unprotected position was visible to a script and
  // to nobody looking at a screen.
  const open = (positions.data && positions.data.positions) || [];
  const naked = open.filter(p => !Number.isFinite(Number(p.sl)) || Number(p.sl) === 0);
  if (naked.length) {
    finding("RED", label, `${naked.length} open position(s) with NO broker-side stop`,
      naked.map(p => `#${p.ticket} ${p.symbol} ${p.type} ${p.volume} lot`).join(", ")
      + " — loss on these is unbounded, and no stop held only in the bridge survives a "
      + "restart, a crash or a power cut",
      "set a stop on these in MT5 now, or close them");
  }

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

  // Does what this box BELIEVES match what the broker actually holds?
  //
  // This is the failure class with the longest history here and nothing was watching
  // it. A -$441.84 loss once sat in the journal as OPEN forever because the close
  // never reached it, and a separate bug asked MT5 for history 22 seconds after launch,
  // got nothing, and never asked again — that one hid the first WIN this system ever
  // had until reconciliation was repaired. Both were found by hand, long after.
  //
  // GHOST and ORPHAN are opposite faults and get different remedies:
  //   GHOST  journal says open, broker does not — the trade CLOSED and the record
  //          never learned. Its P&L is missing and the learning engine never sees the
  //          outcome, which is exactly the -441.84 case.
  //   ORPHAN broker holds a position the journal does not know — nothing in this
  //          system is managing it: no trailing, no partial, no journal entry when it
  //          finally closes.
  //
  // GUARDED, because a false RED here is expensive. The position cache is
  // bridge-populated, so for roughly a minute after a restart the broker list reads
  // EMPTY while the journal still shows opens — which looks exactly like every
  // position ghosting at once. The check therefore stays silent while the server is
  // young or the cache has not been filled yet.
  const journalRows = (journal.data && journal.data.journal) || [];
  const journalOpen = journalRows.filter(t => t && t.status === "OPEN" && t.ticket);
  const startedAt = status.data && status.data.startedAt ? Date.parse(status.data.startedAt) : null;
  const uptimeMs = startedAt ? Date.now() - startedAt : null;
  const cacheWarm = open.length > 0 || (Number.isFinite(uptimeMs) && uptimeMs > POSITION_CACHE_WARM_MS);

  if (journalRows.length && cacheWarm) {
    const brokerTickets = new Set(open.map(p => String(p.ticket)));
    const journalTickets = new Set(journalOpen.map(t => String(t.ticket)));
    const ghosts = journalOpen.filter(t => !brokerTickets.has(String(t.ticket)));
    const orphans = open.filter(p => !journalTickets.has(String(p.ticket)));

    if (ghosts.length) {
      finding("RED", label, `${ghosts.length} position(s) OPEN in the journal that the broker does not hold`,
        ghosts.map(t => `#${t.ticket} ${t.symbol} ${t.direction}`).join(", ")
        + " — these closed and the journal never recorded it, so their P&L is missing from "
        + "the record and the learning engine will never see the outcome",
        "check MT5 history for those tickets and let reconciliation re-run, then confirm "
        + "they appear CLOSED in server/journal.json");
    }
    if (orphans.length) {
      finding("RED", label, `${orphans.length} broker position(s) the journal does not know about`,
        orphans.map(p => `#${p.ticket} ${p.symbol} ${p.type} ${p.volume} lot`).join(", ")
        + " — nothing in this system is managing these: no trailing, no partial, and no "
        + "journal entry when they close",
        "confirm whether these were opened outside SmartEntry; if they are ours, the "
        + "journal write on fill did not land");
    }
  }

  return { settings: settings.data, risk: risk.data, positions: open };
}

/**
 * The exposure no single dashboard shows. Each box renders its OWN positions, so the
 * laptop shows two and the fleet is holding four — and today they are the same two
 * trades on both machines, which means one adverse move in Gold hits both accounts at
 * once. Correlated exposure that is invisible on every screen is the shape of a
 * surprise, so it is stated rather than left to be worked out from two tabs.
 */
function checkFleetExposure(boxes) {
  const withPositions = boxes.filter(([, s]) => s && Array.isArray(s.positions));
  if (withPositions.length < 2) return;

  const all = withPositions.flatMap(([label, s]) => s.positions.map(p => ({ ...p, box: label })));
  if (!all.length) return;

  // Same instrument AND same direction on more than one box: the exposures add rather
  // than offset. Opposite directions across boxes are a different animal and are left
  // alone here — that is a hedge, not a doubling.
  const byKey = new Map();
  for (const p of all) {
    const key = `${p.symbol}|${p.type}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const doubled = [...byKey.entries()].filter(([, rows]) =>
    new Set(rows.map(r => r.box)).size > 1);

  if (doubled.length) {
    finding("AMBER", "fleet",
      `${doubled.length} position(s) held on BOTH boxes at once`,
      doubled.map(([key, rows]) =>
        key.replace("|", " ") + " on " + rows.map(r => r.box).join(" + ")).join("; ")
      + ` — ${all.length} positions across the fleet, but each dashboard shows only its own, `
      + "so the exposure on one screen is half the real number and the halves move together",
      "no action if that is intended — this is the risk being named, not a fault");
  } else {
    finding("INFO", "fleet", `${all.length} position(s) open across the fleet`,
      withPositions.map(([label, s]) => `${label}: ${s.positions.length}`).join(", ")
      + " — no symbol is held in the same direction on both boxes",
      "node tasks/doctor.cjs for the per-box detail");
  }
}

/**
 * @param canReachPeer  whether this box can pull the other one at all.
 *
 * Parity is only runnable from the box that can reach BOTH. The laptop can pull the
 * VPS; the VPS cannot pull back, because the laptop is not reachable from the
 * internet. So on the VPS a stale-parity warning is an item that CAN NEVER CLEAR, and
 * CLAUDE.md is explicit that such an item is worse than none — it trains you to skim
 * past the one that matters. On that box it is reported as a standing INFO naming
 * where the check actually lives, not as a chore nobody there can do.
 */
function checkParity(canReachPeer) {
  const file = path.join(ROOT, "tasks", "logs", "vps_parity_last.json");
  let record = null;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { record = null; }
  const healCmd = ["node", [path.join(ROOT, "tasks", "vps_parity.cjs"), "--emit"]];

  if (!record) {
    finding(canReachPeer ? "AMBER" : "INFO", "fleet", "engine parity has never been recorded here",
      "nothing has confirmed the two boxes run the same engine, so any number pooling " +
      "them is unattributable" + (canReachPeer ? "" :
        ". This box cannot reach its peer, so it cannot run the check — it belongs on the box that can"),
      canReachPeer ? "node tasks/vps_parity.cjs --emit"
                   : "run it on the box that can reach both: node tasks/vps_parity.cjs --emit",
      canReachPeer ? healCmd : null);
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
    if (canReachPeer) {
      finding("AMBER", "fleet", `engine parity last confirmed ${human(age)} ago`,
        "the verdict is stale, and it is only meaningful right after a deploy. Note a plain " +
        "run records NOTHING — the --emit flag is what clears this",
        "node tasks/vps_parity.cjs --emit", healCmd);
    } else {
      finding("INFO", "fleet", `engine parity here last confirmed ${human(age)} ago (run from the peer)`,
        "this box cannot reach its peer, so it can never refresh this itself — the check runs " +
        "from the box that can reach both, and the copy here only updates when that box deploys " +
        "to this one. Nothing to do here; it is not a fault on this machine",
        "on the box that can reach both: node tasks/vps_parity.cjs --emit");
    }
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

/**
 * Can the AI actually work right now, and if not, when can it again?
 *
 * On 2026-08-12 every claude job on the VPS died on "You've hit your weekly limit -
 * resets Aug 13, 11am". Four jobs — morning, daily, analysis, weekly — stopped at once
 * behind a ceiling nothing surfaced, and the only trace was a line in an append-only
 * log. The doctor found the resulting RED hours later and by symptom, not by cause.
 *
 * The two halves are read from the source that is authoritative for each. The LOG says
 * a limit was hit and quotes the notice verbatim, wording and reset time included. The
 * QUEUE says whether the brief survived, and its resetAt was parsed by claude_agent.py
 * at park time rather than re-parsed here.
 *
 * Deliberately does NOT parse the log's own timestamps. Those come from cmd's %date%,
 * which is locale-dependent and differs between these two boxes — the VPS writes US
 * order and the laptop writes UK — so a date read from there is a coin flip. Recency is
 * judged by position in the file instead.
 */
const LIMIT_LOG_TAIL_LINES = 40;

function checkAiCapacity() {
  const logPath = path.join(ROOT, "tasks", "logs", "agent_log.txt");
  let tail = [];
  try {
    tail = fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-LIMIT_LOG_TAIL_LINES);
  } catch (e) { return; }                 // no agent log on this box is not a fault

  const limitLine = [...tail].reverse().find(l => /hit your .*limit|usage limit|rate limit/i.test(l));
  if (!limitLine) return;                 // nothing recent — the AI is working

  let parked = [];
  try {
    parked = fs.readFileSync(path.join(ROOT, "tasks", "agent_queue.jsonl"), "utf8")
      .split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { parked = []; }

  const notice = limitLine.trim().slice(0, 160);
  if (parked.length) {
    const next = parked.map(j => j.resetAt).filter(Boolean).sort()[0];
    finding("INFO", "local", `AI subscription limit hit — ${parked.length} brief(s) parked, not lost`,
      `"${notice}". The queue holds them and the hourly drain resumes them`
      + (next ? ` from ${next}` : " once the window reopens"),
      "python claude_agent.py status");
  } else {
    // A limit with nothing parked is the failure mode this system had until today: the
    // brief was thrown away rather than queued. It is AMBER rather than RED because an
    // OLD notice from before parking existed looks identical from here, and crying RED
    // over history would be its own kind of noise.
    finding("AMBER", "local", "an AI job hit a subscription limit and nothing is parked",
      `"${notice}". Either that brief was lost, or the notice predates the parking fix. `
      + "Every claude job on a box shares one ceiling, so a burst of RED scheduled tasks "
      + "with no other symptom usually means this and not four broken jobs",
      "check tasks/logs/agent_log.txt, then confirm the job's .bat has a "
      + "claude_agent.py park block");
  }
}

// ── the market-hour jobs ────────────────────────────────────────────────────
//
// Two scheduled jobs now run on market time: the post-close analysis at 21:30 UTC and
// the pre-open plan at a slot computed nightly. Nothing watched either of them, and the
// history of this fleet is jobs that stop silently — VPS AutoTrading was off for 11
// days behind green checks, the peer heartbeat 401'd for a week, the weekly review sat
// unread for three days. A scheduled job with no health check is decoration.
//
// Checked through ARTIFACTS and LOGS rather than the Task Scheduler, deliberately.
// schtasks output is localised and the two boxes are in different locales — %date%
// already differs between them — so parsing status text would work here and quietly
// mis-parse there. An artifact with a timestamp inside it means the job actually
// COMPLETED, which is the thing worth knowing; a task reporting "Ready" does not.
const DEEP_PLAN_STALE_HOURS = 26;     // one daily cycle plus slack for a missed run
const PREOPEN_DRIFT_MINUTES = 5;      // trigger vs computed slot; below this is rounding

// `root` is a parameter purely so the branches below can be exercised against a scratch
// directory. A check that has never been seen to FIRE is not a verified check, and this
// one only fires on a day something has already gone wrong.
function checkMarketJobs(root = ROOT) {
  const planFile = path.join(root, "tasks", "analysis", "deep-plan-latest.json");

  let plan = null;
  try {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  } catch (e) {
    finding("AMBER", "local", "no deep plan has ever been built on this box",
      "the pre-open document and its Telegram message are the only daily statement of what "
      + "the gate would need, what the calendar blocks and where the levels are",
      "node tasks\\deep_plan.cjs",
      ["node", [path.join(root, "tasks", "deep_plan.cjs")]]);
    return;
  }

  const age = ageHours(Date.parse(plan.generatedAt));
  if (!Number.isFinite(age)) {
    finding("AMBER", "local", "the deep plan carries no readable generatedAt",
      "its age cannot be judged, so a stale plan would look current",
      "node tasks\\deep_plan.cjs");
  } else if (age > DEEP_PLAN_STALE_HOURS) {
    finding("AMBER", "local", `deep plan is ${human(age)} old`,
      "the post-close job has not completed since then, so this morning's levels, blackouts "
      + "and distance-to-fire all describe a session that has already happened",
      "powershell -File tasks\\postclose_analysis.ps1",
      ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                      path.join(root, "tasks", "postclose_analysis.ps1")]]);
  }

  // Did the last post-close run finish clean? Its own last line carries the count.
  try {
    const lines = fs.readFileSync(path.join(root, "tasks", "logs", "postclose_analysis.txt"), "utf8")
      .split(/\r?\n/).filter(Boolean);
    const lastDone = [...lines].reverse().find(l => l.includes("POST-CLOSE ANALYSIS DONE"));
    const failed = lastDone && /- (\d+) failed/.exec(lastDone);
    if (failed && Number(failed[1]) > 0) {
      finding("AMBER", "local", `last post-close analysis had ${failed[1]} failed harness(es)`,
        "the walk-forward and heat-map artifacts the morning plan reads may be stale or partial, "
        + "and a partial table reads exactly like a complete one",
        "powershell -File tasks\\postclose_analysis.ps1");
    }
  } catch (e) { /* no log yet is covered by the artifact check above */ }

  // THE CHECK THAT MATTERS. The pre-open job is triggered by the Task Scheduler, but the
  // slot it SHOULD fire at is recomputed nightly from the calendar. If the rescheduler
  // failed, the trigger sits at yesterday's time — which is a deliberate failure mode
  // (late beats never) but becomes invisible unless something compares the two. On the
  // day this was built the computed slot moved to 11:45 because PPI blacked out
  // 12:00-13:00, the exact hour the job exists to prepare for.
  const slot = plan.preOpenSlot;
  if (!slot || !slot.at) return;

  let moved = null;
  try {
    const lines = fs.readFileSync(path.join(root, "tasks", "logs", "reschedule_preopen.txt"), "utf8")
      .split(/\r?\n/).filter(Boolean);
    moved = [...lines].reverse().find(l => /moved '|no move needed|NO CHANGE/.test(l)) || null;
  } catch (e) { moved = null; }

  if (!moved) {
    finding("AMBER", "local", "the pre-open trigger has never been reconciled with the computed slot",
      "the job may fire inside a news blackout — the hour before the open is exactly when a "
      + "high-impact release is most likely to sit",
      "powershell -File tasks\\reschedule_preopen.ps1",
      ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                      path.join(root, "tasks", "reschedule_preopen.ps1")]]);
    return;
  }

  if (/NO CHANGE/.test(moved)) {
    finding("AMBER", "local", "the last attempt to move the pre-open trigger failed",
      "the trigger is left at its previous time by design, so the plan still runs — but it "
      + "may now fire inside a blackout: " + moved.slice(0, 120),
      "powershell -File tasks\\reschedule_preopen.ps1",
      ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                      path.join(root, "tasks", "reschedule_preopen.ps1")]]);
    return;
  }

  // The rescheduler ran, but was it for THIS plan? A move recorded before the current
  // plan was built was computed from yesterday's calendar.
  const movedAt = /^\[([\d-]+ [\d:]+)\]/.exec(moved);
  if (movedAt && Date.parse(movedAt[1].replace(" ", "T") + "Z") < Date.parse(plan.generatedAt)) {
    finding("AMBER", "local", "the pre-open trigger was last set before the current plan was built",
      "it was computed from an older calendar, so today's blackouts have not been applied to it",
      "powershell -File tasks\\reschedule_preopen.ps1",
      ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                      path.join(root, "tasks", "reschedule_preopen.ps1")]]);
  }

  if (slot.confident === false) {
    finding("INFO", "local", "the pre-open slot was not chosen from a clean calendar read",
      slot.reason || "the calendar could not be read, or every candidate slot was blacked out",
      "check /api/calendar, then: node tasks\\deep_plan.cjs");
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

/**
 * The peer as seen through its own HEARTBEAT, for the box that cannot reach it.
 *
 * This asymmetry is real and not an oversight: the laptop sets PEER_SERVER_URL and
 * pulls the VPS, but the laptop is not reachable from the internet, so the VPS can
 * never pull back. Left there, the doctor on the box that TRADES was single-box —
 * exactly the one-box blindness this tool exists to end. The laptop already pushes a
 * 5-minute heartbeat carrying its gate, breaker, bridges and unreviewed proposals, so
 * the information was arriving and being ignored.
 *
 * Everything here is therefore AS OF the last check-in, and its age is stated on every
 * finding: a heartbeat is a claim about the past, and treating it as live state is how
 * a dead box looks healthy.
 */
async function checkPeerViaHeartbeat(localGate) {
  const res = await get("http://localhost:3001/api/peer-heartbeat");
  if (res.error || !res.data || !Array.isArray(res.data.peers)) return;
  if (!res.data.peers.length) {
    finding("AMBER", "peer", "no peer has ever checked in",
      "this box cannot reach the peer directly and has received no heartbeat either, so " +
      "the other half of the fleet is entirely unobserved from here",
      "confirm the peer is running and that its monitor is pointed at this box");
    return;
  }

  for (const peer of res.data.peers) {
    const box = `peer ${peer.box || ""}`.trim();
    const age = Number(peer.ageSeconds);
    const asOf = Number.isFinite(age) ? `as of ${Math.round(age / 60)}m ago` : "age unknown";

    // 15 minutes is the standing staleness bar for this channel. Past it, the absence
    // of news is not good news.
    if (Number.isFinite(age) && age > 15 * 60) {
      finding("RED", box, `heartbeat silent for ${Math.round(age / 60)}m`,
        "this box cannot poll the peer, so the heartbeat is the ONLY evidence it is alive; " +
        "silence here is indistinguishable from the peer being down",
        "check the peer is running and that its monitor task is still scheduled");
      continue;                       // everything below would be stale beyond use
    }

    const state = peer.state || {};
    if (state.halted) {
      finding("RED", box, `TRADING HALTED — ${state.haltReason || "circuit breaker open"} (${asOf})`,
        "the peer is taking no new trades", "review the losses, then reset the breaker deliberately");
    }
    if (state.settingsError) {
      finding("RED", box, `running on BUILT-IN DEFAULTS (${asOf})`,
        `settingsError: ${state.settingsError}. The peer's gate and sizing are not what its ` +
        "saved config says", "fix or restore strategy_settings.json on the peer, then restart it");
    }
    if (Array.isArray(state.bridgesSilent) && state.bridgesSilent.length) {
      finding("RED", box, `bridge(s) silent: ${state.bridgesSilent.join(", ")} (${asOf})`,
        "a silent bridge means the peer is not trading and not managing its open positions",
        "on the peer: powershell -File tasks\\ensure_running.ps1");
    }
    if (Number.isFinite(localGate) && Number.isFinite(state.gate) && state.gate !== localGate) {
      finding("RED", "fleet", `confidence gate DIFFERS: this box=${localGate} vs ${peer.box}=${state.gate} (${asOf})`,
        "the two boxes admit different trades from the same bars; pooled performance numbers " +
        "are meaningless until this is reconciled",
        "set both to the intended gate in each box's server/strategy_settings.json");
    }
    if (state.unreviewedProposals > 0) {
      finding("AMBER", box, `${state.unreviewedProposals} AI proposal(s) nobody has decided (${asOf})`,
        "an agent whose correct call goes unread costs exactly what a failing agent costs",
        "on the peer: node tasks/ai_decide.cjs --list");
    }
  }
}

/**
 * Run every check and return the findings, worst first. The ONLY entry point: the CLI
 * below and server/index.js both call this, so the terminal and the dashboard can
 * never drift into disagreeing about the fleet's state.
 */
async function diagnose() {
  findings = [];
  const peer = readEnv("PEER_SERVER_URL");
  const boxes = [["this box", "http://localhost:3001", true]];
  if (peer) boxes.push(["peer", peer, false]);

  const seen = [];
  for (const [label, base, isLocal] of boxes) seen.push([label, await checkBox(label, base, isLocal)]);

  // No PEER_SERVER_URL means this box cannot pull the other one. Fall back to what the
  // peer pushes, rather than reporting on half a fleet and calling it a fleet check.
  if (!peer) {
    const local = seen[0] && seen[0][1];
    await checkPeerViaHeartbeat(local && local.settings && local.settings.confidenceThreshold);
  }

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

  checkFleetExposure(seen);
  checkParity(Boolean(peer));
  checkAgentQueue();
  checkAiCapacity();
  checkMarketJobs();
  checkBackup();
  checkLearningIntegrity();

  const rank = { RED: 0, AMBER: 1, INFO: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    generatedAt: new Date().toISOString(),
    findings,
    counts: findings.reduce((acc, f) => (acc[f.severity] = (acc[f.severity] || 0) + 1, acc), {}),
    feedsTheGate: false,
  };
}

async function runCli() {
  const report = await diagnose();
  const findings = report.findings;

  if (AS_JSON) {
    // Emit the SAME object diagnose() returns, rather than rebuilding a near-copy of it.
    // The two had already drifted: /api/doctor carried `counts` and the CLI did not, so
    // anything written against `--json` broke when pointed at the route and vice versa.
    console.log(JSON.stringify(report, null, 2));
  } else {
    const counts = report.counts;   // already computed by diagnose(); a third tally would only drift
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
}

// Only run as a CLI when invoked directly. Required as a module — which is how
// server/index.js serves /api/doctor — it must define diagnose() and do nothing else,
// or requiring it would print a report and kill the server with process.exit.
if (require.main === module) {
  runCli().catch(err => {
    console.error("doctor: " + String(err && err.message || err));
    process.exit(1);
  });
}

// checkPeerViaHeartbeat is exported for testing. On a healthy fleet it produces NO
// findings, which is indistinguishable from never having run — so it needs to be
// callable with a deliberately wrong gate to prove it evaluates at all.
module.exports = { diagnose, checkPeerViaHeartbeat, checkMarketJobs, _findings: () => findings, _reset: () => { findings = []; } };
