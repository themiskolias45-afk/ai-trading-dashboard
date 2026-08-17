// THE PRE-OPEN PLAN — what to expect before the session that matters, and why.
//
//   node tasks/preopen_plan.cjs [projRoot] [--json]
//
// WHY THIS EXISTS
// Every scheduled job on this fleet is clock-scheduled with no relation to market
// hours. The morning agent runs 05:00 UTC and the daily check 05:30 — both inside the
// ASIAN session, which is the one session measured NEGATIVE at the live gate. Nothing
// ran before the NEW YORK open, which is the only session measured positive.
//
// WHY IT IS DETERMINISTIC AND NOT AN AGENT
// A plan whose probabilities come from an LLM's impression is a guess with a number
// attached, and this project has spent the day proving how easily that reads as
// evidence. Every figure below is either read from the live server or from a
// walk-forward artifact on disk, and each one is printed WITH the sample it rests on.
// It also means the plan still runs when the AI subscription ceiling is closed, which
// it is until 2026-08-13.
//
// WHAT THIS IS NOT
// Not a signal, not an instruction, and it changes nothing. It cannot open a trade or
// move a threshold. It states what the gate would need, what the calendar will block,
// and what the record says about the hours ahead — then stops.
//
// Writes only tasks/analysis/ and appends tasks/logs/preopen_plan.txt.

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2] : path.join(__dirname, "..");
const AS_JSON = process.argv.includes("--json");

// The system's own session boundaries, so a session named here means what it means in
// the heat map, the walk-forward and get_time_context.
const SESSIONS = [
  ["ASIAN",       22, 7],
  ["PRE-LONDON",   7, 9],
  ["LONDON",       9, 12],
  ["OVERLAP",     12, 13],
  ["NEW YORK",    13, 17],
  ["AFTER HOURS", 17, 22],
];

const HTTP_TIMEOUT_MS = 10000;
const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

// Session cookie, because /api/calendar and /api/cohort-reachability are gated like
// /api/fleet and /api/system-plan. Without it this script silently received 401s and
// rendered them as data: it printed "0 of 15 cohorts cannot reach the gate" when the
// real figure is 5, and "no high-impact events left this week" on the eve of PPI. Both
// read as GOOD NEWS, which is the worst possible direction for a read failure to fail
// in, and is exactly the bug this project spent today removing from five dashboards.
let sessionCookie = null;

function readEnv(key) {
  try {
    const line = fs.readFileSync(path.join(ROOT, "keys.env"), "utf8")
      .split(/\r?\n/).find(l => l.startsWith(key + "="));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch (e) { return null; }
}

function login() {
  const username = readEnv("DASHBOARD_USERNAME");
  const password = readEnv("DASHBOARD_PASSWORD");
  if (!username || !password) return Promise.resolve(false);   // not configured: gated routes stay unavailable
  const body = JSON.stringify({ username, password });
  return new Promise(resolve => {
    const req = http.request({
      host: "localhost", port: 3001, path: "/api/login", method: "POST",
      timeout: HTTP_TIMEOUT_MS,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      res.resume();
      const setCookie = res.headers["set-cookie"];
      if (res.statusCode === 200 && setCookie && setCookie.length) {
        sessionCookie = setCookie.map(c => String(c).split(";")[0]).join("; ");
        return resolve(true);
      }
      resolve(false);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.write(body);
    req.end();
  });
}

function get(pathname) {
  return new Promise(resolve => {
    const req = http.get({
      host: "localhost", port: 3001, path: pathname, timeout: HTTP_TIMEOUT_MS,
      headers: sessionCookie ? { Cookie: sessionCookie } : {},
    }, res => {
        let body = "";
        res.on("data", c => (body += c));
        res.on("end", () => {
          // Status first. A 401 parses cleanly and would otherwise become "no data",
          // which on a plan reads as "nothing to trade" rather than "I could not look".
          if (res.statusCode !== 200) return resolve({ error: `HTTP ${res.statusCode}` });
          try { resolve({ data: JSON.parse(body) }); }
          catch (e) { resolve({ error: "unparseable" }); }
        });
      });
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.on("error", e => resolve({ error: e.message }));
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), "utf8")); }
  catch (e) { return null; }
}

function sessionAt(date) {
  const hour = date.getUTCHours();
  const found = SESSIONS.find(([, from, to]) =>
    from < to ? hour >= from && hour < to : hour >= from || hour < to);
  return found ? found[0] : "UNKNOWN";
}

function nextSessionStart(name, from) {
  const bounds = SESSIONS.find(s => s[0] === name);
  if (!bounds) return null;
  const start = new Date(from);
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(bounds[1]);
  if (start <= from) start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

// Exported so tasks/deep_plan.cjs builds ON this rather than beside it. The deep plan
// needs every figure here plus the raw payloads, and a second script re-deriving
// "distance to fire" is exactly how index.html came to hardcode 65 while the gate was
// 70. One implementation, or the two documents disagree in front of you.
async function buildPlan() {
  const now = new Date();
  await login();
  const [settings, signals, risk, calendar, newsfilter, cohorts, positions] = await Promise.all([
    get("/api/strategy-settings"), get("/api/signals"), get("/api/risk-status"),
    get("/api/calendar"), get("/api/newsfilter"), get("/api/cohort-reachability"),
    get("/api/mt5/positions"),
  ]);

  // Refuse rather than guess. Every gap figure below is measured against the gate, and
  // a plan built on an assumed threshold is worse than no plan.
  // Throws rather than exits: a caller (deep_plan) must be able to report the failure
  // in its own document instead of having the process vanish underneath it.
  if (settings.error || !settings.data || !Number.isFinite(settings.data.confidenceThreshold)) {
    throw new Error("cannot read the live gate — " + (settings.error || "no confidenceThreshold"));
  }
  const gate = settings.data.confidenceThreshold;
  const sessionWf = readJson("session-walkforward-latest.json");
  const heatmap = readJson("time-heatmap-latest.json");

  const currentSession = sessionAt(now);
  const nyStart = nextSessionStart("NEW YORK", now);
  const minutesToNy = Math.round((nyStart - now) / 60000);

  // ── per asset: how far from firing, and which leg is short ──
  const assets = ["btc", "gold", "spx"].map(key => {
    const a = signals.data && signals.data[key];
    if (!a) return { key, unavailable: true };
    const conf = Number(a.confidence) || 0;
    return {
      key, label: a.label || key.toUpperCase(),
      confidence: conf, gap: Math.max(0, gate - conf),
      ready: conf >= gate && a.signal && a.signal !== "WAIT",
      signal: a.signal, setup: a.setup, dataSource: a.dataSource,
      legs: { d1: a.signal, h4: a.h4 && a.h4.signal, h1: a.h1 && a.h1.signal },
    };
  });

  // ── what the record says about the session ahead ──
  const sessionEvidence = (() => {
    if (!sessionWf || !sessionWf.atLiveGate) return null;
    const row = (sessionWf.atLiveGate.slices || []).find(s => s.slice === "NEW YORK");
    const hm = heatmap && heatmap.atLiveGate && heatmap.atLiveGate.session
      && heatmap.atLiveGate.session["NEW YORK"];
    return !row ? null : {
      session: "NEW YORK",
      pooled: hm ? { closed: hm.closed, winRatePct: +hm.wr.toFixed(1), rPerTrade: +hm.rpt.toFixed(3) } : null,
      removingItImproves: `${row.foldsImproved}/${row.foldsScored} folds`,
      verdict: row.verdict,
      ranAt: sessionWf.generatedAt,
      // Stated every time. 261 trades over five folds is a reading, not a law.
      caveat: "Out-of-sample replay, not realised P&L. " + sessionWf.atLiveGate.trades
            + " trades at the gate across " + sessionWf.atLiveGate.foldCount + " folds.",
    };
  })();

  // ── what the calendar will actually block ──
  const windowMins = (calendar.data && calendar.data.blackoutWindowMinutes) || 30;
  const blackouts = !calendar.data ? [] : (calendar.data.events || [])
    .filter(e => e.high && e.watched && e.minutesFromNow >= -windowMins)
    .map(e => ({
      title: e.title, country: e.country, at: e.at,
      minutesFromNow: e.minutesFromNow,
      blocksFrom: new Date(Date.parse(e.at) - windowMins * 60000).toISOString(),
      blocksUntil: new Date(Date.parse(e.at) + windowMins * 60000).toISOString(),
      // Does it land inside the session this plan is about?
      inNewYork: sessionAt(new Date(e.at)) === "NEW YORK",
    }));

  // A failed read is reported as UNAVAILABLE, never counted as zero. "0 of 15 dead"
  // and "no events this week" both read as good news, and a read failure must never
  // be able to say something reassuring.
  const cohortsUnavailable = Boolean(cohorts.error) || !cohorts.data;
  const deadCohorts = cohortsUnavailable
    ? []
    : (cohorts.data.rows || []).filter(r => r.status === "DEAD" || r.status === "BLOCKED (MEASURED)");
  const calendarUnavailable = Boolean(calendar.error) || !calendar.data;

  const open = (positions.data && positions.data.positions) || [];
  const naked = open.filter(p => !Number.isFinite(Number(p.sl)) || Number(p.sl) === 0);

  const plan = {
    generatedAt: now.toISOString(),
    currentSession,
    nextNewYorkOpen: nyStart.toISOString(),
    minutesToNewYork: minutesToNy,
    gate,
    settingsError: settings.data.settingsError || null,
    assets,
    sessionEvidence,
    blackouts,
    newsFilter: newsfilter.data
      ? { enabled: newsfilter.data.enabled, watching: newsfilter.data.watching,
          healthy: newsfilter.data.healthy, windowMinutes: newsfilter.data.windowMinutes }
      : null,
    risk: risk.data ? { halted: risk.data.halted, haltReason: risk.data.haltReason,
                        consecutiveLosses: risk.data.consecutiveLosses, dailyPnl: risk.data.dailyPnl } : null,
    openPositions: open.length,
    unprotectedPositions: naked.length,
    deadCohorts: cohortsUnavailable ? null : deadCohorts.length,
    cohortsUnavailable, calendarUnavailable,
    unavailable: [["calendar", calendar.error], ["cohort-reachability", cohorts.error]].filter(x => x[1]).map(x => x[0] + ": " + x[1]),
    deadCohortNames: deadCohorts.map(r => r.name),
    feedsTheGate: false,
  };

  // Raw payloads travel with the plan so the deep document can read levels, indicators
  // and per-setup history without a second round of seven HTTP calls.
  return { plan, raw: { settings, signals, risk, calendar, newsfilter, cohorts, positions },
           now, gate, sessionWf, heatmap, deadCohorts, blackouts, naked, open,
           cohortsUnavailable, calendarUnavailable };
}

function renderPlan(built) {
  const { plan, raw, now, gate, deadCohorts, blackouts, naked, open,
          cohortsUnavailable, calendarUnavailable } = built;
  const { calendar, cohorts } = raw;
  const assets = plan.assets;
  const sessionEvidence = plan.sessionEvidence;
  const nyStart = new Date(plan.nextNewYorkOpen);
  const currentSession = plan.currentSession;
  const minutesToNy = plan.minutesToNewYork;
  {
    const W = 92;
    const L = [];
    L.push("=".repeat(W));
    L.push(`  PRE-OPEN PLAN — ${now.toISOString().replace("T", " ").slice(0, 16)} UTC`);
    L.push(`  now in ${currentSession} · NEW YORK opens ${nyStart.toISOString().slice(11, 16)} UTC `
         + `(${minutesToNy >= 0 ? "in " + Math.floor(minutesToNy / 60) + "h " + (minutesToNy % 60) + "m" : "open"})`);
    L.push(`  live gate ${gate}${plan.settingsError ? "  *** settingsError — running on DEFAULTS ***" : ""}`);
    L.push("=".repeat(W));

    if (plan.risk && plan.risk.halted) {
      L.push("");
      L.push(`  ** TRADING HALTED — ${plan.risk.haltReason || "circuit breaker"}. Nothing below can fire. **`);
    }
    if (naked.length) {
      L.push("");
      L.push(`  ** ${naked.length} OPEN POSITION(S) WITH NO BROKER-SIDE STOP — deal with this first. **`);
    }

    L.push("");
    L.push("  DISTANCE TO FIRE");
    for (const a of assets) {
      if (a.unavailable) { L.push(`    ${a.key.toUpperCase().padEnd(6)} unavailable`); continue; }
      L.push(`    ${a.label.padEnd(12)}${String(a.confidence).padStart(3)}%  `
        + (a.ready ? "READY" : `${a.gap}pt short`).padEnd(12)
        + `D1=${a.legs.d1}  4H=${a.legs.h4}  1H=${a.legs.h1}   ${a.setup || ""} (${a.dataSource || "?"})`);
    }

    L.push("");
    L.push("  THE SESSION AHEAD — what the record says");
    if (sessionEvidence) {
      const p = sessionEvidence.pooled;
      L.push(`    NEW YORK: ${p ? p.closed + " trades, " + p.winRatePct + "% win, "
        + (p.rPerTrade >= 0 ? "+" : "") + p.rPerTrade + "R/trade" : "no pooled figure"}`);
      L.push(`    Removing it improves ${sessionEvidence.removingItImproves} — ${sessionEvidence.verdict}`);
      L.push(`    ${sessionEvidence.caveat}`);
      L.push(`    This is the ONLY session that is positive at the gate; ASIAN, OVERLAP and`);
      L.push(`    AFTER HOURS all improve the book when removed. That is why this plan is`);
      L.push(`    built for the NY open and not for the hours the other jobs run in.`);
    } else {
      L.push("    No session walk-forward on this box — run: node tasks/session_walkforward.cjs");
    }

    L.push("");
    L.push("  WHAT WILL BE BLOCKED");
    if (!plan.newsFilter) {
      L.push("    news filter state unreadable");
    } else if (!plan.newsFilter.enabled) {
      L.push("    News filter OFF — high-impact events will NOT stop an entry.");
    } else if (!plan.newsFilter.healthy) {
      L.push(`    ** News filter enabled but watching ${plan.newsFilter.watching} events — it is not matching the feed. **`);
    } else {
      L.push(`    News filter ACTIVE, watching ${plan.newsFilter.watching} high-impact events, `
        + `${plan.newsFilter.windowMinutes}min either side.`);
    }
    if (calendarUnavailable) {
      // Never let a failed read say something reassuring. "No events this week" on the
      // eve of PPI is far worse than admitting the calendar could not be reached.
      L.push(`    ** CALENDAR UNAVAILABLE (${calendar.error}) — this plan CANNOT say what will be blocked. **`);
    } else if (!blackouts.length) {
      L.push("    No high-impact watched events left this week.");
    } else {
      for (const b of blackouts.slice(0, 6)) {
        L.push(`    ${b.at.slice(5, 16).replace("T", " ")} ${b.country} ${b.title}`
          + `  blocks ${b.blocksFrom.slice(11, 16)}-${b.blocksUntil.slice(11, 16)} UTC`
          + (b.inNewYork ? "   <-- inside NEW YORK" : ""));
      }
    }

    L.push("");
    L.push("  STRUCTURAL LIMITS");
    if (cohortsUnavailable) {
      L.push(`    ** COHORT REACHABILITY UNAVAILABLE (${cohorts.error}) — cannot say which cohorts are dead. **`);
    } else {
      L.push(`    ${plan.deadCohorts} of ${cohorts.data.total} cohorts cannot reach gate ${gate} at maximum`);
      L.push(`    boost — a setup landing in one of those could not fire however good it was.`);
      if (deadCohorts.length) {
        for (const c of deadCohorts) L.push(`      · ${c.name} (base ${c.base}, ceiling ${c.ceiling}) ${c.status}`);
      }
    }
    L.push(`    Open positions: ${open.length}${naked.length ? ` (${naked.length} UNPROTECTED)` : " (all with broker-side stops)"}`);
    if (plan.risk) {
      L.push(`    Breaker: ${plan.risk.consecutiveLosses}/3 consecutive losses, daily P&L ${plan.risk.dailyPnl}`);
    }

    L.push("");
    L.push("  HOW TO READ THIS");
    L.push("  Every number is read live or from a walk-forward artifact, and carries the sample");
    L.push("  it rests on. Nothing here is a signal or an instruction: this plan cannot open a");
    L.push("  trade, move a threshold, or admit a setup. It says what the gate would need, what");
    L.push("  the calendar will block, and what the record says about the hours ahead.");
    L.push("=".repeat(W));

    return L.join("\n") + "\n";
  }
}

// WHY A WRITE FAILURE HERE GETS ITS OWN DIAGNOSIS
// On 2026-08-16 21:39 UTC this exact call failed with `EPERM: operation not permitted,
// open 'tasks/analysis/preopen-plan-latest.json'` and the run exited 2. deep_plan.cjs
// then could not append its own stack either, because tasks/logs/deep_plan.txt was
// locked too. An errno alone has now been collected twice and names no culprit, so the
// next occurrence has to identify the HOLDER.
//
// Deliberately NOT a retry. A silent retry would convert a diagnosable lock into an
// invisible one, and this file's whole job is to refuse to say something reassuring it
// cannot support. The write still fails and the job still exits non-zero; it just says
// who was in the way.
function describeWriteFailure(target, err) {
  const lines = [
    `write FAILED  ${target}`,
    `  ${err.code || "?"} ${err.syscall || ""} errno=${err.errno ?? "?"} — ${err.message}`,
  ];
  try {
    const st = fs.statSync(target);
    lines.push(`  target exists: ${st.size} bytes, mtime ${st.mtime.toISOString()}, mode 0${(st.mode & 0o777).toString(8)}`);
  } catch (e) {
    lines.push(`  target not stat-able: ${e.code || e.message}`);
  }
  // Is it STILL locked, or was it transient? The answer changes the whole diagnosis:
  // a lock that has already cleared points at a scanner or a backup, one that persists
  // points at a live process holding a handle.
  try {
    fs.closeSync(fs.openSync(target, "r+"));
    lines.push("  lock state NOW: writable again — the lock was transient (scanner, backup, or a finished process)");
  } catch (e) {
    lines.push(`  lock state NOW: still unwritable (${e.code || e.message}) — a live holder`);
  }
  // Best-effort candidate holders. handle.exe is Sysinternals and may not be installed,
  // so this enumerates the processes that plausibly touch this tree with their command
  // lines, which is normally enough to name a second copy of the same job. Wrapped and
  // time-boxed: a diagnostic must never become the reason the error is lost.
  try {
    const { execFileSync } = require("child_process");
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|powershell|pwsh' } | "
      + "ForEach-Object { \"pid=$($_.ProcessId) started=$($_.CreationDate) $($_.CommandLine)\" }";
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", timeout: 15000, windowsHide: true });
    const rows = out.split("\n").map(s => s.replace(/\s+$/, "")).filter(Boolean);
    // Split, rather than dump. On a dev box this list is 25 MCP servers and the one
    // process that matters is buried; on the VPS it is one line. Anything whose command
    // line names this project is a plausible SECOND COPY of a job writing here, which is
    // the leading theory — everything else is counted, not printed, because the holder
    // may equally be a scanner or a backup that owns no node process at all.
    const marker = path.basename(ROOT).toLowerCase();
    const mine  = rows.filter(r => r.toLowerCase().includes(marker));
    const other = rows.length - mine.length;
    if (mine.length) {
      lines.push(`  processes referencing ${path.basename(ROOT)} (${mine.length}) — a second copy of a job is the leading theory:`);
      lines.push(...mine.slice(0, 15).map(r => "    " + r));
    } else {
      lines.push(`  NO node/powershell process references ${path.basename(ROOT)} — so the holder is`);
      lines.push("    probably not one of this project's jobs. Look at AV, backup, or file indexing.");
    }
    lines.push(`  other node/powershell processes not referencing this project: ${other}`);
  } catch (e) {
    lines.push(`  candidate holders: could not enumerate (${e.code || e.message})`);
  }
  return lines.join("\n");
}

function writeJsonOrExplain(target, data) {
  try {
    fs.writeFileSync(target, data);
  } catch (err) {
    // Straight to stderr as well as up the throw chain. The post-close harness captures
    // and tails output on failure since 1a6056b, and that channel does not depend on any
    // file in tasks/ being writable — which is exactly what failed last time.
    const diagnosis = describeWriteFailure(target, err);
    try { process.stderr.write(diagnosis + "\n"); } catch (_) { /* nothing left to try */ }
    const wrapped = new Error(diagnosis);
    wrapped.code = err.code;
    throw wrapped;
  }
}

function writeArtifacts(built) {
  const { plan, now } = built;
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const body = JSON.stringify(plan, null, 2);
  // The stamped copy first: if only ONE of the two can be written, the history entry is
  // the more valuable survivor, because -latest is reconstructible from it.
  writeJsonOrExplain(path.join(OUT_DIR, `preopen-plan-${stamp}.json`), body);
  writeJsonOrExplain(path.join(OUT_DIR, "preopen-plan-latest.json"), body);
}

// CLI only when run directly, so `require`ing this from deep_plan.cjs does not fire a
// second plan and overwrite the artifact with a near-duplicate a few seconds newer.
if (require.main === module) {
  (async () => {
    const built = await buildPlan();
    if (AS_JSON) {
      console.log(JSON.stringify(built.plan, null, 2));
    } else {
      const text = renderPlan(built);
      fs.appendFileSync(path.join(ROOT, "tasks", "logs", "preopen_plan.txt"), text + "\n");
      process.stdout.write(text);
    }
    writeArtifacts(built);
  })().catch(e => {
    console.error("preopen-plan: " + e.message);
    process.exit(2);
  });
}

// writeJsonOrExplain and describeWriteFailure are exported for their OWN test: the
// failure path is the whole point of them, and it cannot be exercised through
// writeArtifacts without writing over the live artifacts in tasks/analysis.
module.exports = { buildPlan, renderPlan, writeArtifacts, writeJsonOrExplain, describeWriteFailure,
  sessionAt, nextSessionStart, get, login, SESSIONS, OUT_DIR };
