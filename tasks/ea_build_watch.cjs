// EA BUILD WATCH -- which EA build is actually live, and did it change without anyone doing it?
//
// WHY THIS EXISTS. On 2026-09-06 v3.56 was attached to XAUUSD M15 on the VPS at 17:26. The
// chart profile on disk had been written at 17:21 and still named v355, because MT5 only
// persists a profile on a CLEAN EXIT. So the running build existed in MEMORY ONLY: any
// restart -- a reboot, a crash, MT5 Ensure Running stepping in -- silently reloads the OLDER
// build, and nothing anywhere would have said so.
//
// The revert itself is cosmetic: v3.55 and v3.56 have byte-identical inputs and the same
// magic 26070455, so trading is unchanged and only a dashboard colour and a log word differ.
// The dangerous part is not the revert, it is that it is SILENT -- the same shape as every
// other failure on this fleet: something changed while every check went on saying fine.
//
// SEVERITY IS DELIBERATE AND NOT SYMMETRIC:
//   RED     the EA was recorded before and no attach line survives at all -- the thing meant
//           to run 24/7 may not be running.
//   AMBER   a DIFFERENT build is live than the one last recorded. Cosmetic today, but it
//           means a restart happened and reloaded from a stale profile.
//   GREEN   same build as last recorded.
//   UNKNOWN logs unreadable, nothing to compare against, or the newest line is stale.
//           Never reported as fine.
//
//   node tasks/ea_build_watch.cjs          report + write dashboard/ea-build-watch.json
//   node tasks/ea_build_watch.cjs --json   machine-readable
//
// Read-only against MT5 logs. Places no order, changes no setting, touches no EA.

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dashboard", "ea-build-watch.json");
const STATE = path.join(ROOT, "tasks", "ea_build_watch_state.json");
const AS_JSON = process.argv.includes("--json");
const EA_RE = /(EA_CRT_AMD_Dashboard(?:_v\d+)?)\s*\(([^,]+),([^)]+)\)/;
const STALE_HOURS = 72;
const NUL = String.fromCharCode(0);

function terminalLogDirs() {
  const base = path.join(os.homedir(), "AppData", "Roaming", "MetaQuotes", "Terminal");
  const dirs = [];
  let entries = [];
  try { entries = fs.readdirSync(base); } catch { return dirs; }
  for (const entry of entries) {
    const dir = path.join(base, entry, "MQL5", "Logs");
    try { if (fs.statSync(dir).isDirectory()) dirs.push({ terminal: entry, dir: dir }); }
    catch { /* not a terminal folder -- skip */ }
  }
  return dirs;
}

// MT5 logs are usually UTF-8 but can be UTF-16LE. Decode by BOM, then fall back to sniffing
// for NUL bytes. Guessing wrong here would read as "no EA line", i.e. a false RED.
function readLog(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  const asUtf8 = buf.toString("utf8");
  if (asUtf8.indexOf(NUL) !== -1) return buf.toString("utf16le");
  return asUtf8;
}

function latestAttach() {
  let best = null;
  for (const t of terminalLogDirs()) {
    let files = [];
    try { files = fs.readdirSync(t.dir).filter((f) => /^\d{8}\.log$/.test(f)).sort(); }
    catch { continue; }
    for (const f of files.slice(-5)) {
      let text;
      try { text = readLog(path.join(t.dir, f)); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(EA_RE);
        if (!m) continue;
        const hhmmss = line.match(/\b(\d{2}:\d{2}:\d{2})\b/);
        const stamp = f.slice(0, 4) + "-" + f.slice(4, 6) + "-" + f.slice(6, 8) +
                      " " + (hhmmss ? hhmmss[1] : "00:00:00");
        if (!best || stamp >= best.stamp) {
          best = {
            build: m[1], symbol: m[2].trim(), timeframe: m[3].trim(),
            stamp: stamp, terminal: t.terminal, logFile: f,
            line: line.trim().slice(-200),
          };
        }
      }
    }
  }
  return best;
}

// ── THE ROSTER: what is loaded RIGHT NOW, from the TERMINAL log ──────────────────────────
//
// latestAttach() above reads MQL5\Logs -- the EXPERTS log -- where this EA prints only at
// attach. Measured 2026-09-08: EA_CRT_AMD printed 0 lines on the VPS on 09-07 and 09-08
// while it was demonstrably attached and trading. So silence there is not evidence of
// absence, and a staleness cut over that log can only ever answer UNKNOWN.
//
// The TERMINAL log (<terminal>\logs\YYYYMMDD.log, NOT MQL5\Logs) answers it outright:
//     Terminal | MetaTrader 5 x64 build 6182 started for MetaQuotes Ltd.
//     Experts  | expert EA_CRT_AMD_Dashboard_v355 (XAUUSD,M15) loaded successfully
//     Experts  | expert EA_CRT_AMD_Dashboard_v355 (XAUUSD,M15) removed
//     Experts  | expert EA_CRT_AMD_Dashboard_v356 (XAUUSD,M15) loaded successfully
// Replaying load/remove from the newest "started" banner gives the exact live roster.
// That is how the VPS was confirmed on v356 and the laptop confirmed to hold no CRT EA
// at all -- a fact the 72h cut had been reporting as UNKNOWN for four days.
//
// If no "started" banner falls inside the window the session cannot be bounded, so the
// roster is marked UNREADABLE and the caller falls back to the attach-line logic. Absence
// of evidence is never upgraded into evidence of absence.
const EXPERT_RE  = /\bexpert\s+(\S+)\s+\(([^,]+),([^)]+)\)\s+(loaded successfully|removed)/;
const STARTED_RE = /MetaTrader\s+5\b.*\bstarted\b/;
const ROSTER_LOG_DAYS = 30;

function terminalRosters() {
  const out = [];
  const base = path.join(os.homedir(), "AppData", "Roaming", "MetaQuotes", "Terminal");
  let entries = [];
  try { entries = fs.readdirSync(base); } catch { return out; }
  for (const entry of entries) {
    const dir = path.join(base, entry, "logs");
    let files = [];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      files = fs.readdirSync(dir).filter((f) => /^\d{8}\.log$/.test(f)).sort().slice(-ROSTER_LOG_DAYS);
    } catch { continue; }
    if (!files.length) continue;

    const events = [];
    for (const f of files) {
      let text;
      try { text = readLog(path.join(dir, f)); } catch { continue; }
      const day = f.slice(0, 4) + "-" + f.slice(4, 6) + "-" + f.slice(6, 8);
      for (const line of text.split(/\r?\n/)) {
        const hhmmss = line.match(/\b(\d{2}:\d{2}:\d{2})\b/);
        const stamp = day + " " + (hhmmss ? hhmmss[1] : "00:00:00");
        const m = line.match(EXPERT_RE);
        if (m) {
          events.push({ stamp: stamp, kind: m[4] === "removed" ? "remove" : "load",
                        key: m[1] + " (" + m[2].trim() + "," + m[3].trim() + ")", build: m[1] });
        } else if (STARTED_RE.test(line)) {
          events.push({ stamp: stamp, kind: "start" });
        }
      }
    }

    let lastStart = -1;
    for (let i = 0; i < events.length; i++) if (events[i].kind === "start") lastStart = i;
    if (lastStart === -1) { out.push({ terminal: entry, readable: false }); continue; }

    const loaded = new Map();
    for (let i = lastStart + 1; i < events.length; i++) {
      const e = events[i];
      if (e.kind === "load") loaded.set(e.key, e);
      else if (e.kind === "remove") loaded.delete(e.key);
    }
    out.push({
      terminal: entry, readable: true, sessionStart: events[lastStart].stamp,
      loaded: Array.from(loaded.values()).map((e) => ({ key: e.key, build: e.build, since: e.stamp })),
    });
  }
  return out;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; }
}

const now = new Date();
const live = latestAttach();
const prev = loadState();
const rosters = terminalRosters();
const readableRosters = rosters.filter((r) => r.readable);
const rosterHit = readableRosters
  .map((r) => ({ r: r, hit: r.loaded.find((x) => EA_RE.test(x.key)) }))
  .find((x) => x.hit);

let verdict, severity, detail;
// ROSTER FIRST. When the terminal log can be read it answers the question outright, and no
// amount of attach-line age can override direct evidence of what is loaded.
if (rosterHit) {
  const hit = rosterHit.hit;
  if (prev && prev.build && prev.build !== hit.build) {
    verdict = "BUILD CHANGED";
    severity = "AMBER";
    detail = hit.build + " is LOADED (" + hit.key + ") since " + hit.since + ", but the last " +
             "recorded build was " + prev.build + ". A restart reloaded a different build from " +
             "the saved chart profile, or someone reattached. The change was silent, which is " +
             "the part worth seeing.";
  } else {
    verdict = "LOADED";
    severity = "GREEN";
    detail = hit.key + " is LOADED, confirmed from the terminal log: loaded " + hit.since +
             ", terminal session started " + rosterHit.r.sessionStart + ". This is the roster " +
             "itself, not an inference from attach-line age.";
  }
} else if (readableRosters.length) {
  // Readable roster, EA absent. This is a real answer and it is NOT the same as UNKNOWN --
  // but it is deliberately AMBER, not RED: the CRT EA is deployed on the VPS, so a laptop
  // without it is a fact to see rather than an outage. A permanent RED that no action on
  // this box can clear is the alarm-that-cannot-clear shape this fleet has been bitten by.
  const roster = readableRosters
    .map((r) => r.terminal.slice(0, 8) + " [session " + r.sessionStart + "]: " +
                (r.loaded.length ? r.loaded.map((x) => x.key).join(", ") : "(no experts loaded)"))
    .join("  |  ");
  verdict = "NOT LOADED IN THIS TERMINAL SESSION";
  severity = "AMBER";
  detail = "No EA matching " + String(EA_RE) + " is loaded on this box. The terminal log is " +
           "readable and this is what IS loaded -- " + roster +
           (prev && prev.build ? ".  Last recorded here: " + prev.build + " at " + prev.stamp : "") +
           ". Reported from the roster, so it is certain, not a staleness guess.";
} else if (!live) {
  if (prev && prev.build) {
    verdict = "EA NOT FOUND IN LOGS";
    severity = "RED";
    detail = "Last recorded build was " + prev.build + " at " + prev.stamp +
             ", and no attach line appears in the recent logs at all.";
  } else {
    verdict = "NO ATTACH LINE";
    severity = "UNKNOWN";
    detail = "No EA attach line found, and nothing recorded before, so there is nothing to " +
             "compare against. This is not evidence the EA is absent.";
  }
} else {
  // LOCAL, not UTC. MT5 writes its logs in the machine's LOCAL time and the two boxes sit in
  // different zones (laptop +1, VPS +2), so appending "Z" here made the VPS report an attach
  // "-1.8h ago" -- a time in the future. Dropping the suffix parses it in the local zone,
  // which is the zone MT5 actually wrote it in.
  const ageH = (now - new Date(live.stamp.replace(" ", "T"))) / 3600000;
  if (!prev || !prev.build) {
    verdict = "BASELINE RECORDED";
    severity = "GREEN";
    detail = "First run. Recorded " + live.build + " on " + live.symbol + " " + live.timeframe + ".";
  } else if (prev.build !== live.build) {
    verdict = "BUILD CHANGED";
    severity = "AMBER";
    detail = "Live build is " + live.build + ", last recorded was " + prev.build + ". MT5 " +
             "restarted and reloaded from the saved chart profile, or someone reattached. " +
             "Inputs and magic are identical across v355/v356 so trading is unaffected -- " +
             "but the change was silent, which is the part worth seeing.";
  } else if (ageH > STALE_HOURS) {
    verdict = "ATTACH LINE IS STALE";
    severity = "UNKNOWN";
    detail = "Same build (" + live.build + ") but the newest attach line is " +
             ageH.toFixed(1) + "h old. MT5 logs only at attach, so a later removal would " +
             "leave no trace and cannot be ruled out from here.";
  } else {
    verdict = "UNCHANGED";
    severity = "GREEN";
    detail = live.build + " on " + live.symbol + " " + live.timeframe +
             ", attached " + ageH.toFixed(1) + "h ago.";
  }
}

const report = {
  generatedAt: now.toISOString(),
  feedsTheGate: false,
  verdict: verdict,
  severity: severity,
  detail: detail,
  live: live,
  roster: rosters,
  previous: prev,
  note: "Read-only against MT5 logs. Places no order, changes no setting, touches no EA. " +
        "MT5 writes an attach line only at attach, so the absence of a NEW line is not the " +
        "absence of the EA.",
};

// Record the baseline only when one was actually read, so a bad decode can never overwrite a
// good baseline with nothing.
const baseline = rosterHit
  ? { build: rosterHit.hit.build, symbol: rosterHit.hit.key, stamp: rosterHit.hit.since }
  : live;
if (baseline && baseline.build) {
  try {
    fs.writeFileSync(STATE, JSON.stringify({
      build: baseline.build, symbol: baseline.symbol, stamp: baseline.stamp,
      recordedAt: now.toISOString(),
    }, null, 2), "utf8");
  } catch (e) { report.stateWriteError = e.message; }
}

if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

try {
  const tmp = OUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2), "utf8");
  fs.renameSync(tmp, OUT);
} catch (e) { console.log("could not write " + OUT + ": " + e.message); }

console.log("");
console.log("=== EA BUILD WATCH ===");
console.log("");
console.log("  verdict   " + severity + " -- " + verdict);
console.log("  detail    " + detail);
if (live) {
  console.log("  live      " + live.build + "  " + live.symbol + " " + live.timeframe +
              "  " + live.stamp + "  (terminal " + live.terminal.slice(0, 8) + ")");
}
console.log("");
