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

// The sleep verifier queries the Windows event log, which is not instant. Bounded so a
// slow event log degrades this one finding rather than the whole doctor run.
const SLEEP_VERIFY_TIMEOUT_MS = 25000;
// One source of truth for the mojibake pattern. A second copy of that regex here is
// exactly how the first detection attempt missed six damaged files: it had the Latin-1
// form and the real damage was cp1252.
const { scanDir: scanEncoding } = require("./encoding_check.cjs");

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
const SELFTEST_STALE_HOURS = 26;  // the daily job runs once a day, plus slack for a miss
const BRIDGE_STALE_SEC    = 180;
// One loss short of the limit is a warning; AT the limit is a fault, because the box
// is already breaker-tripped and only reports it on the next trade attempt. This used
// to be a flat 2 with the message "one more loss halts this box" hardcoded against a
// limit of 3, so a box standing at 3 of 3 read as having a loss of headroom it did not
// have. The real limit comes from the box's own config, never from this constant.
const BREAKER_WARN_MARGIN = 1;   // losses short of the limit that still count as AMBER
const BREAKER_LIMIT_FALLBACK = 3; // only when the box does not report maxConsecLosses
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
    } else {
      const streak = risk.data.consecutiveLosses || 0;
      // Each account carries its own configured limit; take the tightest, because the
      // first account to reach its own limit is the one that stops trading.
      const limits = Object.values(risk.data.accounts || {})
        .map(a => a && a.config && a.config.maxConsecLosses)
        .filter(n => Number.isFinite(n) && n > 0);
      const limit = limits.length ? Math.min(...limits) : BREAKER_LIMIT_FALLBACK;
      if (streak >= limit) {
        finding("RED", label, `${streak} consecutive losses of ${limit} — AT the limit, reporting halted:false`,
          "the breaker threshold is already met, so the next trade attempt halts this box. Until "
          + "one is attempted nothing re-evaluates it, and every surface reports trading as live",
          "review the losses and reset deliberately, or accept that the next signal will not be taken");
      } else if (streak >= limit - BREAKER_WARN_MARGIN) {
        finding("AMBER", label, `${streak} consecutive losses of ${limit}`,
          "one more loss halts this box; worth knowing BEFORE it happens rather than after",
          "no action required — this is a warning, not a fault");
      }
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
        // The ledger names the action when it knows one — an expired login is fixed by
        // signing in, not by reading a log whose entire content says so.
        finding("RED", label, `job ${job.label}: ${job.verdict}`, job.detail || "",
          job.remedy || `inspect ${job.lastFile || job.script}`);
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
function checkParity(canReachPeer, root = ROOT) {
  const file = path.join(root, "tasks", "logs", "vps_parity_last.json");
  let record = null;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { record = null; }
  const healCmd = ["node", [path.join(root, "tasks", "vps_parity.cjs"), "--emit"]];

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

// THE STRATEGY LAB, whose every failure mode is silence.
//
// The lab is a 24/7 loop of generate -> drain -> promote across two boxes, and every
// way it can break looks identical from outside: nothing happens. The scheduled task
// stops firing and the log simply stops. The drain throws and records FAILED rows
// nobody reads. A candidate clears the bar and the Telegram credentials are missing,
// so the one alert the whole system exists to produce is swallowed. None of that
// raises an error anywhere.
//
// Two of these were REAL on 2026-08-31, found by hand rather than by any check: the
// promotion bar was unclearable in principle (no axis had enough values, so nothing
// could EVER be promoted and it read as 'no strategy is good enough'), and the
// notifier's credential parser matched zero keys on a CRLF file and reported 'not
// configured' forever. Both would have run silently for months.
//
// Read-only: file reads under `root`, and a PRESENCE test on keys.env that never
// reads a value. Nothing here feeds a gate, a threshold, confidence or sizing.
function checkLab(root = ROOT) {
  const labDir = path.join(root, "tasks", "analysis", "lab");
  const drainLog = path.join(root, "tasks", "logs", "lab_drain.txt");

  // A box with no lab is not a fault. Say nothing rather than inventing a finding.
  if (!fs.existsSync(labDir) && !fs.existsSync(drainLog)) return;

  // ── 1. is the loop still turning? ──────────────────────────────────────
  // The cycle runs every 15 minutes. A log that has stopped growing is the ONLY
  // outward sign that the task died, because a dead task raises nothing.
  const STALE_AMBER_MIN = 60;
  const STALE_RED_MIN = 360;
  if (!fs.existsSync(drainLog)) {
    finding("AMBER", "local", "lab drain has never run here",
      "the queue will fill and nothing will execute it",
      "powershell -NoProfile -ExecutionPolicy Bypass -File tasks\\install_lab_drain.ps1 -Execute");
  } else {
    const ageMin = (Date.now() - fs.statSync(drainLog).mtimeMs) / 60000;
    if (ageMin > STALE_RED_MIN) {
      finding("RED", "local", `lab drain silent for ${human(ageMin * 60000)}`,
        "the 15-minute cycle has stopped; nothing is being generated, run or judged",
        "Get-ScheduledTask -TaskName 'SmartEntry Lab Drain' | Get-ScheduledTaskInfo");
    } else if (ageMin > STALE_AMBER_MIN) {
      finding("AMBER", "local", `lab drain last ran ${human(ageMin * 60000)} ago`,
        "expected every 15 minutes",
        "Get-ScheduledTask -TaskName 'SmartEntry Lab Drain' | Get-ScheduledTaskInfo");
    }
  }

  // ── 2. the queue: failures recorded but unread, and jobs that never ran ──
  const queueFile = path.join(labDir, "_queue.jsonl");
  if (fs.existsSync(queueFile)) {
    const byId = new Map();
    for (const line of fs.readFileSync(queueFile, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { const r = JSON.parse(t); if (r && r.id) byId.set(r.id, Object.assign(byId.get(r.id) || {}, r)); }
      catch (e) { /* a torn line must not kill the check */ }
    }
    const jobs = [...byId.values()];
    const failed = jobs.filter(j => j.status === "FAILED");
    if (failed.length) {
      finding("AMBER", "local", `${failed.length} lab job(s) FAILED`,
        (failed[0].error || "no reason recorded").slice(0, 120),
        "node tasks/lab_queue.cjs --status");
    }
    // QUEUED and old means the drain is not keeping up, or is not running at all.
    const STUCK_HOURS = 2;
    const stuck = jobs.filter(j => j.status === "QUEUED" && j.queuedAt &&
      (Date.now() - Date.parse(j.queuedAt)) > STUCK_HOURS * 3600000);
    if (stuck.length) {
      finding("AMBER", "local", `${stuck.length} lab job(s) queued over ${STUCK_HOURS}h and never run`,
        "the generator is adding faster than the drain is clearing, or the drain is dead",
        "node tasks/lab_queue.cjs --drain");
    }
  }

  // ── 3. a candidate cleared the bar and is WAITING FOR A HUMAN ───────────
  // The entire loop exists to produce this. It must never sit unread.
  const staged = path.join(labDir, "_promotable.jsonl");
  if (fs.existsSync(staged)) {
    const rows = [];
    for (const line of fs.readFileSync(staged, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch (e) { /* ignore a torn line */ }
    }
    const open = rows.filter(r => r && r.appliedToLive !== true);
    if (open.length) {
      finding("AMBER", "local", `${open.length} lab candidate(s) cleared the bar and are unreviewed`,
        "staged only - nothing has been applied to live, and nothing will be without you: " +
        (open[open.length - 1].label || "").slice(0, 100),
        "node tasks/lab_promote.cjs --list   then open /lab and read the plateau");
    }
  }

  // ── 4. could an alert even reach you? ──────────────────────────────────
  // PRESENCE ONLY - this never reads a credential value. A clearing candidate with no
  // notifier configured is the loop's whole purpose landing in a file nobody opens.
  const keys = path.join(root, "keys.env");
  if (fs.existsSync(keys)) {
    const raw = fs.readFileSync(keys, "utf8");
    const has = n => {
      const m = new RegExp("^\\s*" + n + "\\s*=\\s*(.*)$", "m").exec(raw);
      const v = m ? m[1].trim().replace(/^[\"']|[\"']$/g, "") : "";
      return Boolean(v) && !v.startsWith("${");
    };
    if (!has("TELEGRAM_TOKEN") || !has("TELEGRAM_CHAT_ID")) {
      finding("AMBER", "local", "lab notifier has no Telegram credentials",
        "a candidate that clears the bar would be staged silently and never reach you",
        "set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in keys.env (never in a tracked file)");
    }
  }

  // ── 5. the search space is exhausted ───────────────────────────────────
  // Not a fault - the generator correctly stops rather than inventing noise. But a
  // loop with nothing left to explore is idle, and idle looks exactly like working.
  if (fs.existsSync(drainLog)) {
    const tail = fs.readFileSync(drainLog, "utf8").split(/\r?\n/).slice(-40).join("\n");
    if (/fully explored/i.test(tail)) {
      finding("INFO", "local", "lab has explored its whole declared space",
        "it is running but generating nothing new; widening is a deliberate act because " +
        "every new cell is a trial that raises the deflation bar for its family",
        "edit PARAM_GRID in tasks/lab_generate.cjs, then: node tasks/lab_generate.cjs --space");
    }
  }
}

function checkAgentQueue(root = ROOT) {
  const file = path.join(root, "tasks", "agent_queue.jsonl");
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
      ["python", [path.join(root, "claude_agent.py"), "drain"]]);
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

function checkAiCapacity(root = ROOT) {
  const logPath = path.join(root, "tasks", "logs", "agent_log.txt");
  let tail = [];
  try {
    tail = fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-LIMIT_LOG_TAIL_LINES);
  } catch (e) { return; }                 // no agent log on this box is not a fault

  const limitLine = [...tail].reverse().find(l => /hit your .*limit|usage limit|rate limit/i.test(l));
  if (!limitLine) return;                 // nothing recent — the AI is working

  let parked = [];
  try {
    parked = fs.readFileSync(path.join(root, "tasks", "agent_queue.jsonl"), "utf8")
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

/**
 * Did the self-healing heartbeat itself stop?
 *
 * `ensure_running.ps1` is the thing that restarts everything else, and on 2026-08-19 it
 * did not run for 4h30m: the laptop was suspended by an Application API call nine minutes
 * after the charger came out, and Task Scheduler does not fire repetition intervals during
 * Modern Standby. Server, bridge, guardian, tunnel and both terminals were dead for the
 * whole window.
 *
 * Nothing saw it, and the reason is worth stating: the log reads HEALTHY on both sides of
 * the hole. The last tick before said "SERVER: up, BRIDGE A reporting 1s ago" and the first
 * tick after said the same, because by then it had restarted them. Reading the last line of
 * this file — which is all anything did — reports a fleet that has just been resurrected as
 * a fleet that never fell over. The gap IS the signal, and only the gap.
 *
 * AMBER vs INFO turns on whether anything actually had to be restarted, rather than on the
 * length of the hole. That discriminator is not decoration: a clock change moves these
 * timestamps by an hour twice a year, and the local `--- start ---` lines are the only
 * clock this file has. A DST jump produces a gap with a completely ordinary block after it;
 * a real outage produces one whose next block is full of "starting". So the benign case
 * lands as INFO with its cause named, instead of crying AMBER every spring.
 *
 * Timestamps here are LOCAL and the two boxes are in different timezones — which does not
 * matter, because every comparison is between two ticks in the SAME file.
 */
const ENSURE_TICK_MINUTES   = 10;   // the repetition install_autostart.ps1 registers
const COVERAGE_GAP_FACTOR   = 3;    // three missed ticks is a hole, not a slow run
const COVERAGE_TAIL_LINES   = 4000; // ~3 days at ~9 lines a tick; bounded, this log is rotated
const COVERAGE_LOOKBACK_HOURS = 48; // older than this is history, not something to act on
// What ensure_running.ps1 writes when it had to FIX something rather than confirm it:
// "SERVER: down -- starting", "BRIDGE A: not reporting -- starting", "TERMINAL 1: starting",
// "GUARDIAN: starting", "JARVIS: no window -- opening".
const COVERAGE_RESTART_RE = /(--\s*starting|--\s*opening|:\s*starting\s*$|:\s*down\b)/im;

/**
 * Did the sleep fix hold?
 *
 * This lives in the doctor rather than on a timer for a reason that is the whole point of
 * the finding: this box is asleep 58.7% of the time and has NEVER been woken by a timer -
 * 0 of 200 episodes since May, every one of them a hibernate. A scheduled check would be
 * subject to the exact fault it is meant to measure. The doctor is read at session start,
 * so putting it here means it is read whenever anyone is actually looking.
 *
 * Reports three outcomes that are easy to conflate, and refuses to call the third a pass:
 * fix applied and holding, applied and not holding, and NOT APPLIED - which is a null
 * result, not a success. See tasks/SLEEP-RUNBOOK.md.
 */
function checkSleepFix(root = ROOT) {
  const script = path.join(root, "tasks", "sleep_verify.ps1");
  const baseline = path.join(root, "tasks", "sleep_baseline.json");
  if (!fs.existsSync(script) || !fs.existsSync(baseline)) return;   // nothing recorded yet

  let out;
  try {
    out = execFileSync("powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8", timeout: SLEEP_VERIFY_TIMEOUT_MS, windowsHide: true });
  } catch (e) {
    // A non-zero exit is the "NOT FIXED" verdict, which still carries usable stdout.
    out = (e && e.stdout) ? String(e.stdout) : "";
    if (!out) {
      finding("INFO", "local", "sleep verification did not run",
        `${String((e && e.message) || e).slice(0, 120)} — the numbers behind it are still in tasks/sleep_baseline.json`,
        "powershell -File tasks\\sleep_verify.ps1");
      return;
    }
  }

  const applied = /applied:\s*YES/i.test(out);
  const verdict = (out.split(/\r?\n/).find(l => /VERDICT:/.test(l)) || "").replace(/^\s*VERDICT:\s*/, "").trim();
  const pct = (out.match(/percent asleep\s+([\d.]+)\s+([\d.]+)/) || []);
  const wasPct = pct[1], nowPct = pct[2];

  if (!applied) {
    finding("INFO", "local", "sleep fix not applied yet — the laptop still hibernates unattended",
      `baseline: ${wasPct || "58.7"}% of the last ~112 days asleep, 0 timer wakes in 200 episodes, all 200 hibernated. `
      + "Nothing wakes this box, so WakeToRun cannot help and the only fix is preventing the sleep. "
      + "This is a null result, not a pass — there is nothing to hold yet",
      "read tasks\\SLEEP-RUNBOOK.md, then apply Option A: powercfg /requestsoverride PROCESS node.exe SYSTEM (elevated)");
    return;
  }

  // TOO EARLY is not a failure and must not read as one. sleep_verify emits it when the
  // fix has been running for less than a night against a baseline days older, so every
  // episode in the window predates the change. Without this the doctor printed "applied
  // but NOT holding" for a fix that had not yet had a chance to hold.
  if (/TOO EARLY/i.test(verdict)) {
    const heldFor = (out.match(/Fix running for ([\d.]+)h/) || [])[1];
    finding("INFO", "local", "sleep fix applied — too early to judge",
      verdict || `running ${heldFor || "<1"}h, baseline is older than that`,
      "re-check after 24h: powershell -File tasks\\sleep_verify.ps1");
    return;
  }

  if (/HELD|IMPROVED/i.test(verdict)) {
    finding("INFO", "local", "sleep fix is holding",
      verdict || `asleep ${wasPct}% before, ${nowPct}% since`,
      "no action — re-check with: powershell -File tasks\\sleep_verify.ps1");
    return;
  }

  finding("AMBER", "local", "sleep fix applied but NOT holding",
    (verdict || `still ${nowPct}% asleep against a ${wasPct}% baseline`)
      + " — the power request is being released by something",
    "elevated: powercfg /requests   (shows who holds or drops the SYSTEM request)");
}

function checkCoverageGaps(root = ROOT) {
  const file = path.join(root, "tasks", "logs", "ensure_running.txt");
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-COVERAGE_TAIL_LINES);
  } catch (e) {
    finding("AMBER", "local", "no ensure_running log on this box",
      "nothing confirms the task that restarts everything else has ever run here, and it is "
      + "the only thing that recovers this box unattended",
      "powershell -File tasks\install_autostart.ps1   then check tasks\logs\ensure_running.txt");
    return;
  }

  // Written as 'yyyy-MM-dd HH:mm:ss' by Write-Log — ISO order, so unlike the cmd %date%
  // logs elsewhere in this fleet it parses the same on both boxes.
  const ticks = [];
  lines.forEach((line, i) => {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] --- ensure_running start ---/.exec(line);
    if (m) ticks.push({ at: new Date(m[1] + "T" + m[2]), index: i });
  });
  if (ticks.length < 2) return;       // nothing to compare; a single tick is not a gap

  const thresholdMin = ENSURE_TICK_MINUTES * COVERAGE_GAP_FACTOR;
  const holes = [];
  for (let i = 1; i < ticks.length; i++) {
    const gapMin = (ticks[i].at - ticks[i - 1].at) / 60000;
    // Negative means the clock moved backwards between ticks — an autumn DST step or a
    // time resync. Not a coverage hole, and not something this check can speak to.
    if (!(gapMin > thresholdMin)) continue;
    if (ageHours(ticks[i].at.getTime()) > COVERAGE_LOOKBACK_HOURS) continue;
    holes.push({ gapMin, before: ticks[i - 1], after: ticks[i] });
  }
  if (!holes.length) return;

  // The WORST hole gets the detail, but the COUNT is what tells you whether this is an
  // incident or a habit. Reporting only the largest is how a box that is offline half of
  // every day reads as one bad night — which is exactly what this looked like on the run
  // that found it: 4h30m named, and nine more holes in the same week left unsaid.
  const worst = holes.reduce((a, b) => (b.gapMin > a.gapMin ? b : a));
  const totalHours = holes.reduce((sum, h) => sum + h.gapMin, 0) / 60;

  // The block belonging to the tick that ENDED the gap: everything up to the next tick.
  const nextTick = ticks.find(t => t.index > worst.after.index);
  const block = lines.slice(worst.after.index, nextTick ? nextTick.index : lines.length);
  const restarted = block.filter(l => COVERAGE_RESTART_RE.test(l));
  const localDay = (d) => String(d.getMonth() + 1).padStart(2, "0") + "/" +
                          String(d.getDate()).padStart(2, "0");
  const when = (d) => localDay(d) === localDay(worst.after.at)
    ? d.toTimeString().slice(0, 5)
    : localDay(d) + " " + d.toTimeString().slice(0, 5);
  const window = `${when(worst.before.at)} -> ${when(worst.after.at)} local`;
  const gap = human(worst.gapMin / 60);
  const others = holes.length > 1
    ? `${holes.length} holes in the last ${COVERAGE_LOOKBACK_HOURS}h totalling ${human(totalHours)}; worst was `
    : "";

  if (restarted.length) {
    /* INFO, not AMBER, and the wording is the point.
     *
     * USER DECISION 2026-08-29: "is the laptop, i can't keep laptop 24/7". The
     * laptop sleeping is INTENDED. It is the development box; the VPS is the one
     * that trades continuously, and that is the whole reason the VPS exists.
     *
     * So this can never clear, and CLAUDE.md is explicit that an action item which
     * cannot clear is worse than none — it trains you to skim past the row that
     * matters. It was AMBER with a "read Kernel-Power 42" remedy, which sent two
     * sessions hunting a fault that was a laptop being a laptop.
     *
     * The measurement is KEPT in full, because the RECOVERY is the useful part:
     * what came back tells you ensure_running did its job. Only the severity and
     * the call to action change. If this box ever stops being a laptop, or the
     * gaps start appearing on the PEER, that is a different finding entirely —
     * the peer branch is unaffected and a VPS hole stays an alarm.
     */
    finding("INFO", "local", `${others}${gap} with no ensure_running tick, and ${restarted.length} component(s) restarted after it`,
      `${window}. The heartbeat runs every ${ENSURE_TICK_MINUTES} minutes, so this is `
      + `${Math.floor(worst.gapMin / ENSURE_TICK_MINUTES)} missed ticks. What came back: `
      + restarted.map(l => l.replace(/^\[[^\]]+\]\s*/, "").trim()).join("; ")
      + ". This box was asleep for that window, which is EXPECTED — it is a laptop and "
      + "is not kept on 24/7 by decision. The recovery is what this row is for: "
      + "ensure_running restarted what it found missing. The VPS is the box that runs "
      + "continuously, and a hole THERE would be a real alarm",
      "no action — laptop sleep is accepted. Coverage that must not have gaps belongs "
      + "on the VPS, not here");
  } else {
    finding("INFO", "local", `${others}${gap} with no ensure_running tick, but nothing needed restarting`,
      `${window}. Everything was still up when the heartbeat resumed, so this is the `
      + "scheduler not firing rather than an outage — a suspended machine, or a clock "
      + "change moving these local timestamps",
      "no action if the machine was asleep; these timestamps are local and shift with DST");
  }
}

/**
 * Is the TradingView plan still being drawn?
 *
 * `tradingview_bot.py` reads /api/signals LIVE, so its levels are never stale by
 * design - and Gold sat on the chart with days-old numbers anyway, because nothing ran
 * it. No scheduled task on either box invoked it, so the chart held whatever a human
 * last drew by hand. The engine was correct and the drawer was simply never called,
 * which looks identical from the chart.
 *
 * `tasks\tv_daily_plan.ps1` now runs it daily and writes a PER-RUN verdict. Reading
 * that file rather than the cumulative history is the same rule the self-test check
 * follows: a history log can only ever prove the job worked SOMETIME.
 *
 * ABSENCE IS INFO, NOT AMBER. The VPS has no TradingView session and never will unless
 * someone puts credentials there, so a missing log on that box is correct rather than
 * broken. An action item that can never clear trains you to skim past the one that
 * matters, so this says which box draws instead of nagging the one that does not.
 *
 * AMBER at worst: a chart with old lines on it cannot open, size or stop a trade.
 */
const TV_PLAN_STALE_HOURS = 26;   // one daily cycle plus slack for a missed run

function checkTvPlan(root = ROOT) {
  const file = path.join(root, "tasks", "logs", "tv_daily_plan_last.txt");
  const remedy = "powershell -File tasks\tv_daily_plan.ps1   (add -DryRun to test the "
               + "preconditions without drawing)";
  const heal = ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                               path.join(root, "tasks", "tv_daily_plan.ps1")]];

  let text, age;
  try {
    text = fs.readFileSync(file, "utf8");
    age = ageHours(fs.statSync(file).mtimeMs);
  } catch (e) {
    finding("INFO", "local", "no TradingView plan has been drawn from this box",
      "the drawing bot attaches to a logged-in Edge session over CDP 9222, which exists "
      + "on the laptop only - on a box without that session this is expected, not a fault",
      "if this box SHOULD draw: " + remedy);
    return;
  }

  const verdict = /\[tv-plan exit (-?\d+)\]\s*(.*)/.exec(text);
  if (!verdict) {
    finding("AMBER", "local", "the last TradingView plan run recorded no verdict",
      "the per-run file exists but carries no [tv-plan exit N] line, which is what a run "
      + "that died partway through looks like - so the chart's state is unknown, not good",
      remedy, heal);
    return;
  }

  if (Number(verdict[1]) !== 0) {
    finding("AMBER", "local", `TradingView plan FAILED: ${verdict[2] || "no detail"}`,
      "the charts still show whatever was drawn last time, and nothing on them says so. "
      + "Exit 2 means it refused because the server was down (correct - it will not draw "
      + "from a dead engine); 3 means Edge never came up on CDP 9222",
      remedy, heal);
    return;
  }

  if (age > TV_PLAN_STALE_HOURS) {
    finding("AMBER", "local", `TradingView plan last drawn ${human(age)} ago`,
      "the job runs daily, so this old means it has not completed since then - the entry, "
      + "stop and target on the charts are from an older signal than the engine is serving",
      remedy, heal);
  }
}

/**
 * Has the sizing trigger come due?
 *
 * The largest single lever on returns in this system is the FIXED lot size (read it
 * live from strategy_settings.json - it was 0.01 and is 0.02 as of 2026-08-25; naming a
 * number here is how this comment went stale in the first place, caught by
 * tasks/config_drift.cjs on 2026-08-27),
 * which discards the correct risk-based sizing get_lot_size already computes. It
 * was given a stated trigger — XAUUSD alone, >=30 closed fills with positive
 * expectancy after costs — precisely so it would not be flipped on a feeling.
 *
 * A trigger nobody watches gets decided by whoever remembers it first, so it is
 * watched here. The ladder is deliberate:
 *
 *   not met      INFO   — a standing state, reported so progress is visible.
 *                         AMBER here would be an item that cannot clear for
 *                         months, which trains you to skim past the one that can.
 *   met          AMBER  — an action item that CAN clear: flip it, or record the
 *                         decision not to. Either retires this.
 *   unmeasurable AMBER  — a watcher that cannot read is not a quiet trigger, and
 *                         must never be reported as one.
 *
 * Nothing here flips anything. tasks/sizing_trigger.cjs writes no config either.
 */
function checkSizingTrigger(root = ROOT) {
  const remedy = "node tasks/sizing_trigger.cjs   (--json for the raw record)";
  let record;
  try {
    // Required lazily so a doctor run on a box mid-deploy, where this module has
    // not landed yet, reports a readable finding instead of dying at load time
    // and taking every other check with it.
    const { readGoldRecord } = require(path.join(root, "tasks", "sizing_trigger.cjs"));
    record = readGoldRecord(root);
  } catch (e) {
    finding("AMBER", "local", "the sizing trigger cannot be measured on this box",
      `reading Gold's closed record failed (${e.message}). The trigger is the largest lever `
      + "on returns in the system, and a watcher that cannot read is indistinguishable from "
      + "a trigger that has not come due",
      remedy);
    return;
  }

  // Reported before the trigger itself, because it changes what every R figure on this
  // box MEANS - including the expectancy the trigger turns on. Found on the VPS
  // 2026-08-19: its index.js is patched rather than copied and still carries the pre-cap
  // scorer, so the box that trades continuously is the one computing R unguarded.
  if (!record.scorerHasImplausibleRCap) {
    finding("AMBER", "local", "this box's server scores realized R with NO implausible-R cap",
      "realizedRFromPrices here is the pre-cap version - no MAX_PLAUSIBLE_RR, no isFinite "
      + "guard - so a single trade whose stop collapsed toward entry can dominate every R "
      + "number this box serves. That cap exists because exactly one such row inverted the "
      + "sign of a 498-episode ledger. It is a source patch to server/index.js, so it needs "
      + "a human: state the change and get it confirmed before touching the trading box",
      "compare against the laptop's realizedRFromPrices, then patch server/index.js on this "
      + "box (add MAX_PLAUSIBLE_RR = 10 and its guard) and restart the server");
  }

  if (!record.countMet) {
    finding("INFO", "local",
      `sizing trigger: ${record.scored}/${record.remaining + record.scored} Gold fills`,
      `the flip from fixedLotSize 0.01 needs ${record.remaining} more closed XAUUSD trades on `
      + "this box before expectancy is even asked. Gold alone, not pooled - pooling lets BTC "
      + "and SPX vote on a Gold decision",
      remedy);
    return;
  }

  if (!record.expectancyPositive) {
    finding("INFO", "local",
      `sizing trigger: ${record.scored} Gold fills but expectancy is negative`,
      "the count is met and the second condition is not. That is the condition protecting "
      + "real money, and it is doing its job - this is not a partial pass",
      remedy);
    return;
  }

  finding("AMBER", "local",
    record.evidenceThin
      ? `SIZING TRIGGER MET on thin evidence (${record.scored} fills, ${record.netMean.toFixed(3)}R net)`
      : `SIZING TRIGGER MET (${record.scored} fills, ${record.netMean.toFixed(3)}R net)`,
    record.evidenceThin
      ? "the stated condition is satisfied but the 95% lower bound still spans zero, so "
        + "'positive' and 'proven' are not the same word here. Decide knowingly - it "
        + "multiplies losses 7-12x identically, and this item clears either way once decided"
      : "both conditions of the recorded trigger are met and the interval clears zero. The "
        + "change is one config value on BOTH boxes, not code",
    remedy);
}

function checkBackup(root = ROOT) {
  const file = path.join(root, "tasks", "logs", "backup_log.txt");
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
 * Do THIS box's own checks still fire?
 *
 * Everything else in this file reports on the system. This one reports on the reporter,
 * and it is the check that closes the loop the rest of the file depends on: a doctor whose
 * branches have silently stopped firing produces the same clean output as a healthy fleet.
 * That is not hypothetical — the encoding check's first version called all eight dashboard
 * pages clean while six were corrupted, and most of this file's branches had never been
 * observed doing anything at all until doctor_selftest.cjs existed.
 *
 * The nightly daily job runs the suite and writes its output here. Reading a PER-RUN file
 * rather than a cumulative log is deliberate: a cumulative log can only tell you that the
 * suite passed SOMETIME, which is the same mistake as a marker written where nobody reads
 * it. The `[selftest exit N]` line is written by the .bat AFTER the run, so its absence is
 * itself a finding — that is the fingerprint of a job that died mid-run.
 *
 * AMBER, not RED, on the same ladder the rest of this file uses: severity here tracks
 * trading impact, and a doctor that cannot verify itself does not stop a trade. It does
 * mean the absence of REDs stops being evidence, which is why the wording says so.
 */
function checkDoctorSelftest(root = ROOT) {
  const file = path.join(root, "tasks", "logs", "doctor_selftest_last.txt");
  // No case count in this string. The suite grows every time a check is added, and a
  // number written here would be stale within a week - it already was, at 39 versus 44.
  const remedy = "node tasks/doctor_selftest.cjs   (exit 1 names the checks that did not fire)";

  let text, age;
  try {
    text = fs.readFileSync(file, "utf8");
    age = ageHours(fs.statSync(file).mtimeMs);
  } catch (e) {
    finding("AMBER", "local", "the doctor's own checks have never been verified on this box",
      "nothing confirms the checks in this file still fire, and a doctor whose branches have "
      + "silently stopped firing reports exactly what a healthy fleet reports",
      remedy);
    return;
  }

  const cases = /(\d+) of (\d+) cases behaved/.exec(text);
  const exitLine = /\[selftest exit (-?\d+)\]/.exec(text);

  if (!exitLine) {
    finding("AMBER", "local", "the last doctor self-test recorded no verdict",
      "the output file exists but has no [selftest exit N] line, which is what a run that "
      + "died partway through looks like — so its result is unknown, not good",
      remedy);
    return;
  }

  if (Number(exitLine[1]) !== 0) {
    const failed = [...text.matchAll(/^\s+- (.+)$/gm)].map(m => m[1].trim());
    finding("AMBER", "local",
      `doctor self-test FAILING${cases ? ` — ${cases[1]} of ${cases[2]} cases behaved` : ""}`,
      (failed.length ? "did not fire or fired wrongly: " + failed.join("; ") + ". " : "")
      + "Until this passes, a clean doctor report is not evidence of a clean fleet — the "
      + "checks that would have objected may simply be broken",
      remedy);
    return;
  }

  if (age > SELFTEST_STALE_HOURS) {
    finding("AMBER", "local", `doctor self-test last passed ${human(age)} ago`,
      "the daily job runs it every day, so this old means the job has not completed since "
      + "then and the checks have been unverified for that long",
      remedy);
  }
}

/**
 * Are the pages this box serves still readable?
 *
 * On 2026-08-17 a scripted CSS-token edit ran `Get-Content -Raw` (which decodes with the
 * system ANSI codepage on PowerShell 5.1, not UTF-8) and wrote the result back as UTF-8.
 * Six pages lost every emoji, em-dash and box-drawing character; titles read
 * "SmartEntry Pro <garbage> System" on BOTH boxes. Nothing detected it: the output is
 * well-formed UTF-8 holding the wrong characters, so there is no exception, no invalid
 * byte, and node --check passes. It was found by looking at a screenshot.
 *
 * `dir` is a parameter so the branch can be exercised against a directory of known-bad
 * files. A check that has never been seen to FIRE is not a verified check.
 *
 * AMBER, not RED: this cannot affect a trade, a gate or a position. It is a reading
 * surface being unreadable, which matters because these pages are how the fleet is
 * judged - but nothing here is urgent enough to justify the exit code that pages a human.
 *
 * NOT healable, deliberately. The repair is `git checkout <sha> -- <file>` and choosing
 * the sha needs judgement: each file's last clean commit differs, and restoring them all
 * from one would have silently reverted the fleet bar-freshness work that landed between
 * two of them. An automated "fix" here could destroy good code to fix cosmetics.
 */
function checkDashboardEncoding(dir = path.join(ROOT, "dashboard")) {
  const result = scanEncoding(dir);

  // A directory that cannot be read is worth one line, not silence - on the VPS this
  // path exists, so its absence would mean something is wrong with the checkout.
  if (result.error) {
    finding("INFO", "local", "dashboard pages could not be scanned for mojibake",
      result.error + " - so nothing here confirms the served pages are readable",
      "confirm the dashboard directory exists on this box");
    return;
  }
  if (!result.damaged) return;

  const damaged = result.rows.filter(r => r.bad > 0);
  finding("AMBER", "local", `${damaged.length} dashboard page(s) hold mis-decoded text`,
    damaged.map(r => `${r.name} (${r.mojibake + r.replacement})`).join(", ")
    + " - emoji, em-dashes and box-drawing characters render as garbage. The files are "
    + "valid UTF-8 holding the wrong characters, so no parser, syntax check or deploy "
    + "will ever complain; the last time this happened it reached both boxes",
    "node tasks/encoding_check.cjs   for the lines, then per file: "
    + "git log --oneline -5 -- dashboard/<file>   and   git checkout <sha> -- dashboard/<file>");
}

/**
 * The journal and the learning engine must tell the same story about closed trades.
 * They currently do not, deliberately — a trade whose setup name was lost upstream is
 * refused rather than attributed to a phantom bucket — so this reports the gap and
 * says WHY rather than calling it a fault.
 */
function checkLearningIntegrity(root = ROOT) {
  let journal, learning;
  try { journal = JSON.parse(fs.readFileSync(path.join(root, "server", "journal.json"), "utf8")); }
  catch (e) { return; }
  try { learning = JSON.parse(fs.readFileSync(path.join(root, "server", "learning.json"), "utf8")); }
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
async function checkPeerViaHeartbeat(localGate, base = "http://localhost:3001") {
  const res = await get(base + "/api/peer-heartbeat");
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
  checkSizingTrigger();
  checkCoverageGaps();
  checkSleepFix();
  checkTvPlan();
  checkDashboardEncoding();
  checkDoctorSelftest();
  checkLearningIntegrity();
  checkLab();

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

// EVERY check is exported, and every file-reading check takes an optional `root` while the
// HTTP ones take an optional `base`. The defaults are exactly the production values, so
// diagnose() behaves identically — the parameters exist solely so the branches can be
// FORCED to fire.
//
// That is the point. On a healthy fleet these functions produce no findings, which is
// indistinguishable from never having run at all, and this file's own history is full of
// checks that were wrong in exactly that silence: the position-cache guard needed a young
// server to be exercised, checkMarketJobs only fires on a day something has already gone
// wrong, and the encoding check reported eight pages clean while six were damaged. A check
// that has never been seen to fire is not a verified check, it is a comment that looks like
// one. tasks/doctor_selftest.cjs drives all of them.
module.exports = {
  diagnose,
  checkBox, checkFleetExposure, checkParity, checkAgentQueue, checkAiCapacity,
  checkMarketJobs, checkBackup, checkSizingTrigger, checkCoverageGaps, checkSleepFix, checkTvPlan,
  checkDashboardEncoding, checkDoctorSelftest,
  checkLearningIntegrity,
  checkLab,
  checkPeerViaHeartbeat,
  _findings: () => findings, _reset: () => { findings = []; } };
