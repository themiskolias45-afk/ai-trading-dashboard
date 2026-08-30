#!/usr/bin/env node
"use strict";

/**
 * tasks/gate_health.cjs — the dead-gate detector for the universal rejection ledger
 * (tasks/REJECTION-LEDGER-SPEC.md §5).
 *
 * WHY THIS EXISTS
 * Gold's DAILY_ONLY_H4_NEUTRAL cohort was capped at confidence 74 by
 * SIZING_BOOST_MIN_CONFIDENCE - 1 while dailyOnlyMinConfidence floored it at 75.
 * Capped below its own floor: 1131 replay steps, 0 fired, maxConf exactly 74, 792 of
 * those steps sitting in the 65-74 band. It ran that way for months on both machines
 * and nothing reported it. It was found by hand, by accident.
 *
 * THE TRAP THIS TOOL HAS TO AVOID
 * The ledger records ONLY rejections. So "the maximum `actual` never reached the
 * threshold" is true by construction for every gate that ever worked correctly —
 * on its own it is not evidence of anything. Reporting it as an alarm would fire on
 * all nine gates and the tool would be ignored inside a week. A dead gate can only be
 * asserted with a DENOMINATOR:
 *
 *   1. GET /api/gate-health   — killed/passed counters (spec §5), or
 *   2. the MTF replay census  — per-cohort steps/fired/maxConf, or
 *   3. neither, in which case the only ledger-side hint is the shape of the
 *      rejected distribution: a hard pile-up of identical `actual` values flush
 *      below the threshold with nothing in between. That is a SUSPICION, is
 *      labelled as one, and exits with its own code.
 *
 * Read-only. Never writes the ledger. Writes nothing at all unless --out is passed,
 * and then only inside tasks/analysis/ or tasks/logs/. No network beyond localhost.
 *
 * USAGE
 *   node tasks/gate_health.cjs [options]
 *     --ledger <path>        default tasks/rejections.jsonl
 *     --legacy <path>        default tasks/rr_rejected.jsonl (frozen MIN_RR rows)
 *     --no-legacy            ignore the legacy file
 *     --server <baseUrl>     default http://localhost:3001 (localhost only)
 *     --no-server            skip the endpoint; run ledger-only, degraded
 *     --days <n>             only consider rejections from the last n days
 *     --census-file <path>   file containing an MTF_CENSUS line (repeatable)
 *     --run-census <SYM:TICKER[:WINDOW]>  run tasks/_replay_mtf.cjs (repeatable,
 *                            offline, reads tasks/history/*.csv, ~60s per asset)
 *     --alarm-on-dead        also exit non-zero for a dead gate with no geometry
 *     --json                 emit the machine-readable report on stdout
 *     --out <path>           also write the JSON report (tasks/analysis|logs only)
 *
 * EXIT CODES
 *   0  no unreachable gate found
 *   1  usage / unrecoverable tool error
 *   2  UNREACHABLE gate or never-firing cohort CONFIRMED against a real denominator
 *   3  UNREACHABLE only SUSPECTED (degraded: no pass counter, no census)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

// ── constants: every number that decides an outcome is named ─────────────────
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_LEDGER_PATH = path.join(REPO_ROOT, "tasks", "rejections.jsonl");
const DEFAULT_LEGACY_LEDGER_PATH = path.join(REPO_ROOT, "tasks", "rr_rejected.jsonl");
const REPLAY_SCRIPT_PATH = path.join(REPO_ROOT, "tasks", "_replay_mtf.cjs");
const ALLOWED_OUTPUT_DIRS = [
  path.join(REPO_ROOT, "tasks", "analysis"),
  path.join(REPO_ROOT, "tasks", "logs"),
];

const DEFAULT_SERVER_BASE_URL = "http://localhost:3001";
const GATE_HEALTH_ENDPOINT_PATH = "/api/gate-health";
const SERVER_TIMEOUT_MS = 3000;
const LOCALHOST_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];

// A gate needs a healthy kill count before "zero passes" means anything. Below this
// the gate simply has not been exercised enough to distinguish dead from quiet.
const MIN_KILLS_FOR_DEAD_GATE = 20;
// The rejected distribution must pile up on one exact value this many times before
// the ceiling is called hard rather than coincidental.
const HARD_CEILING_MIN_HITS = 3;
// ...and that ceiling must sit this close to the threshold. A cap 40% below the
// floor is a different (and less interesting) problem than a cap of floor-minus-one.
const UNREACHABLE_MAX_SHORTFALL_PCT = 10;
// Rejections landing this close to the threshold are near misses — where a mispriced
// constraint hides.
const NEAR_MISS_BAND_PCT = 3;
const NEAR_MISS_MIN_ROWS = 3;
const NEAR_MISS_MIN_SHARE = 0.25;

// A cohort needs this many replay steps before "never fired" is a measurement.
const CENSUS_MIN_STEPS = 100;
const CENSUS_RUN_TIMEOUT_MS = 240000;
const CENSUS_DEFAULT_WINDOW_BARS = 40;
const CENSUS_MAX_STDERR_BYTES = 8 * 1024 * 1024;

// Two floats read out of JSON are "the same value" within this relative tolerance.
const FLOAT_EQUALITY_RATIO = 1e-9;
const MS_PER_DAY = 86400000;

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_UNREACHABLE_CONFIRMED = 2;
const EXIT_UNREACHABLE_SUSPECTED = 3;

// Spec §2. Unknown gates are reported, not silently folded in — a typo'd gate name
// upstream would otherwise become an invisible bucket.
const KNOWN_GATES = new Set([
  "MIN_RR", "ENTRY_RSI", "CONFIDENCE", "COHORT_FLOOR", "SPREAD",
  "AI_FILTER", "NEWS_BLACKOUT", "STALE_SOURCE", "DUPLICATE", "MAX_POSITIONS",
]);

// Fallback only. Polarity is inferred from the data first (see inferPolarity) because
// the data cannot drift out of date and this table can.
const GATE_POLARITY_FALLBACK = {
  MIN_RR: "floor", ENTRY_RSI: "floor", CONFIDENCE: "floor", COHORT_FLOOR: "floor",
  SPREAD: "ceiling", MAX_POSITIONS: "ceiling",
};

// ── small helpers ────────────────────────────────────────────────────────────
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nearlyEqual(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= FLOAT_EQUALITY_RATIO * scale;
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function parseTimestampMs(rawTs) {
  if (typeof rawTs !== "string") return null;
  const parsed = Date.parse(rawTs);
  return Number.isNaN(parsed) ? null : parsed;
}

// ── argument parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options = {
    ledgerPath: DEFAULT_LEDGER_PATH,
    legacyPath: DEFAULT_LEGACY_LEDGER_PATH,
    useLegacy: true,
    serverBaseUrl: DEFAULT_SERVER_BASE_URL,
    useServer: true,
    days: null,
    censusFiles: [],
    censusRuns: [],
    alarmOnDead: false,
    json: false,
    outPath: null,
    help: false,
  };

  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--help": case "-h": options.help = true; break;
      case "--ledger": options.ledgerPath = path.resolve(takeValue(flag, i)); i++; break;
      case "--legacy": options.legacyPath = path.resolve(takeValue(flag, i)); i++; break;
      case "--no-legacy": options.useLegacy = false; break;
      case "--server": options.serverBaseUrl = takeValue(flag, i); i++; break;
      case "--no-server": options.useServer = false; break;
      case "--days": {
        const days = Number(takeValue(flag, i));
        if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
        options.days = days; i++; break;
      }
      case "--census-file": options.censusFiles.push(path.resolve(takeValue(flag, i))); i++; break;
      case "--run-census": options.censusRuns.push(parseCensusSpec(takeValue(flag, i))); i++; break;
      case "--alarm-on-dead": options.alarmOnDead = true; break;
      case "--json": options.json = true; break;
      case "--out": options.outPath = path.resolve(takeValue(flag, i)); i++; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  return options;
}

function parseCensusSpec(spec) {
  const parts = spec.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`--run-census wants SYMBOL:TICKER[:WINDOW], got "${spec}"`);
  }
  const window = parts[2] === undefined ? CENSUS_DEFAULT_WINDOW_BARS : Number(parts[2]);
  if (!Number.isFinite(window) || window <= 0) {
    throw new Error(`--run-census window must be a positive number, got "${parts[2]}"`);
  }
  return { symbol: parts[0], ticker: parts[1], window };
}

// --out is the only write this tool can perform. Containment is checked rather than
// trusted so a scheduled run can never be pointed at server/index.js or the ledger.
function assertOutputPathAllowed(outPath) {
  const resolved = path.resolve(outPath);
  const allowed = ALLOWED_OUTPUT_DIRS.some((dir) => {
    const relative = path.relative(dir, resolved);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!allowed) {
    throw new Error(`--out must land inside tasks/analysis/ or tasks/logs/, got ${resolved}`);
  }
  return resolved;
}

// ── ledger reading ───────────────────────────────────────────────────────────
/**
 * Reads one JSONL ledger. Missing, empty and corrupt are three DIFFERENT normal
 * states on a fresh box and each gets its own honest state string — never a throw.
 */
function readLedgerFile(filePath, normaliseRow) {
  const result = {
    path: filePath, state: "ok", rows: [], totalLines: 0,
    malformedLines: 0, unusableRows: 0, unknownGates: {}, error: null,
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (readError) {
    result.state = readError.code === "ENOENT" ? "missing" : "unreadable";
    result.error = readError.message;
    return result;
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  result.totalLines = lines.length;
  if (lines.length === 0) {
    result.state = "empty";
    return result;
  }

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (parseError) {
      result.malformedLines++;
      continue;
    }
    const row = normaliseRow(parsed);
    if (!row) { result.unusableRows++; continue; }
    if (!KNOWN_GATES.has(row.gate)) {
      result.unknownGates[row.gate] = (result.unknownGates[row.gate] || 0) + 1;
    }
    result.rows.push(row);
  }
  return result;
}

function normaliseCurrentRow(parsed) {
  if (!parsed || typeof parsed !== "object" || typeof parsed.gate !== "string") return null;
  return {
    gate: parsed.gate,
    sourceSymbol: typeof parsed.sourceSymbol === "string" ? parsed.sourceSymbol : null,
    timeframe: typeof parsed.timeframe === "string" ? parsed.timeframe : null,
    setup: typeof parsed.setup === "string" ? parsed.setup : null,
    threshold: isFiniteNumber(parsed.threshold) ? parsed.threshold : null,
    actual: isFiniteNumber(parsed.actual) ? parsed.actual : null,
    tsMs: parseTimestampMs(parsed.ts),
    origin: "ledger",
  };
}

// tasks/rr_rejected.jsonl is frozen under the old schema (spec §1): no `gate`, the
// threshold is `minRr` and the failing value is `rr`. Normalised in, never rewritten.
function normaliseLegacyRow(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (!isFiniteNumber(parsed.rr) && !isFiniteNumber(parsed.minRr)) return null;
  return {
    gate: "MIN_RR",
    sourceSymbol: typeof parsed.sourceSymbol === "string" ? parsed.sourceSymbol : null,
    timeframe: typeof parsed.timeframe === "string" ? parsed.timeframe : null,
    setup: typeof parsed.setup === "string" ? parsed.setup : null,
    threshold: isFiniteNumber(parsed.minRr) ? parsed.minRr : null,
    actual: isFiniteNumber(parsed.rr) ? parsed.rr : null,
    tsMs: parseTimestampMs(parsed.ts),
    origin: "legacy",
  };
}

function filterRowsByAge(rows, days, nowMs) {
  if (days === null) return { rows, droppedUndated: 0 };
  const cutoffMs = nowMs - days * MS_PER_DAY;
  let droppedUndated = 0;
  const kept = rows.filter((row) => {
    if (row.tsMs === null) { droppedUndated++; return false; }
    return row.tsMs >= cutoffMs;
  });
  return { rows: kept, droppedUndated };
}

// ── grouping and geometry ────────────────────────────────────────────────────
/**
 * Groups rejections by gate + sourceSymbol + timeframe — the same scope the spec
 * dedupes on. Gate alone is too coarse: Gold's dead cohort would be buried under
 * healthy BTC and SPX rejections carrying the same gate name.
 */
function groupRejections(rows) {
  const groups = new Map();
  for (const row of rows) {
    const scopeKey = `${row.gate}|${row.sourceSymbol || "?"}|${row.timeframe || "?"}`;
    let group = groups.get(scopeKey);
    if (!group) {
      group = {
        key: scopeKey, gate: row.gate,
        sourceSymbol: row.sourceSymbol, timeframe: row.timeframe,
        rows: [], firstTsMs: null, lastTsMs: null,
      };
      groups.set(scopeKey, group);
    }
    group.rows.push(row);
    if (row.tsMs !== null) {
      if (group.firstTsMs === null || row.tsMs < group.firstTsMs) group.firstTsMs = row.tsMs;
      if (group.lastTsMs === null || row.tsMs > group.lastTsMs) group.lastTsMs = row.tsMs;
    }
  }
  return [...groups.values()];
}

/**
 * Which side of the threshold a failing observation sits on. Inferred from the rows
 * themselves: every row here is a rejection, so they all lie on the failing side.
 */
function inferPolarity(numericRows, gate) {
  let below = 0;
  let above = 0;
  for (const row of numericRows) {
    if (row.actual < row.threshold) below++;
    else if (row.actual > row.threshold) above++;
  }
  if (below > 0 && above === 0) return "floor";
  if (above > 0 && below === 0) return "ceiling";
  return GATE_POLARITY_FALLBACK[gate] || "unknown";
}

/**
 * The distance from the CLOSEST failing observation to the threshold, plus how hard
 * the ceiling under it looks. A merely strict gate produces a rejected distribution
 * that creeps continuously up to the threshold; a capped one piles identical values
 * on a single number and leaves a clean gap above it.
 */
function analyseGroupGeometry(group) {
  const numericRows = group.rows.filter((row) => isFiniteNumber(row.actual) && isFiniteNumber(row.threshold));
  if (numericRows.length === 0) {
    return { state: "no-numeric-rows", polarity: "unknown", threshold: null };
  }

  // Rows are only comparable against the threshold that was actually in force. Mixing
  // configs would invent a gap that no single configuration ever had.
  const dated = numericRows.filter((row) => row.tsMs !== null);
  const newest = (dated.length > 0 ? dated : numericRows)
    .reduce((best, row) => (best === null || (row.tsMs || 0) >= (best.tsMs || 0) ? row : best), null);
  const threshold = newest.threshold;
  const thresholdsSeen = [...new Set(numericRows.map((row) => row.threshold))].sort((a, b) => a - b);
  const comparable = numericRows.filter((row) => nearlyEqual(row.threshold, threshold));

  const polarity = inferPolarity(comparable, group.gate);
  if (polarity === "unknown") {
    return {
      state: "unknown-polarity", polarity, threshold, thresholdsSeen,
      comparableRows: comparable.length,
    };
  }

  const actuals = comparable.map((row) => row.actual);
  const closestActual = polarity === "floor" ? Math.max(...actuals) : Math.min(...actuals);
  const shortfall = polarity === "floor" ? threshold - closestActual : closestActual - threshold;
  const thresholdScale = Math.abs(threshold) > 0 ? Math.abs(threshold) : 1;
  const shortfallPct = (shortfall / thresholdScale) * 100;

  const ceilingHits = actuals.filter((value) => nearlyEqual(value, closestActual)).length;
  const nearMissRows = actuals.filter(
    (value) => (Math.abs(value - threshold) / thresholdScale) * 100 <= NEAR_MISS_BAND_PCT
  ).length;

  return {
    state: "ok",
    polarity,
    threshold,
    thresholdsSeen,
    comparableRows: comparable.length,
    closestActual,
    shortfall: roundTo(shortfall, 6),
    shortfallPct: roundTo(shortfallPct, 3),
    ceilingHits,
    ceilingHitRate: roundTo(ceilingHits / comparable.length, 4),
    nearMissRows,
    nearMissShare: roundTo(nearMissRows / comparable.length, 4),
    // The fingerprint: a hard pile-up flush below the threshold that never crosses it.
    hardCeiling: shortfall > 0
      && shortfallPct <= UNREACHABLE_MAX_SHORTFALL_PCT
      && ceilingHits >= HARD_CEILING_MIN_HITS,
  };
}

// ── /api/gate-health ─────────────────────────────────────────────────────────
function assertLocalhost(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (urlError) {
    throw new Error(`--server is not a URL: ${baseUrl}`);
  }
  if (!LOCALHOST_HOSTNAMES.includes(parsed.hostname)) {
    throw new Error(`--server must be localhost (this tool makes no off-box requests), got ${parsed.hostname}`);
  }
  return parsed;
}

function httpGetJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: SERVER_TIMEOUT_MS }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode !== 200) {
          resolve({ state: "http-error", error: `HTTP ${response.statusCode}`, body });
          return;
        }
        try {
          resolve({ state: "ok", payload: JSON.parse(body) });
        } catch (parseError) {
          resolve({ state: "bad-json", error: parseError.message, body });
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ state: "unreachable", error: `no response in ${SERVER_TIMEOUT_MS}ms` });
    });
    request.on("error", (requestError) => {
      resolve({ state: "unreachable", error: requestError.message });
    });
  });
}

/**
 * Spec §5 fixes the semantics (killed/passed per gate) but not the JSON shape, so
 * every plausible shape agent A might ship is accepted and anything else degrades
 * loudly instead of throwing.
 */
function normaliseGateStats(payload) {
  const stats = new Map();
  const addEntry = (gateName, counters) => {
    if (typeof gateName !== "string" || !counters || typeof counters !== "object") return;
    const killed = firstFiniteOf(counters, ["killed", "kills", "rejected"]);
    const passed = firstFiniteOf(counters, ["passed", "passes", "accepted"]);
    if (killed === null && passed === null) return;
    stats.set(gateName, { killed: killed === null ? 0 : killed, passed: passed === null ? 0 : passed });
  };

  const container = payload && typeof payload === "object"
    ? (payload.gates || payload.gateStats || payload)
    : null;
  if (!container || typeof container !== "object") return null;

  if (Array.isArray(container)) {
    for (const entry of container) {
      if (entry && typeof entry === "object") addEntry(entry.gate || entry.name, entry);
    }
  } else {
    for (const [gateName, counters] of Object.entries(container)) addEntry(gateName, counters);
  }
  return stats.size > 0 ? stats : null;
}

function firstFiniteOf(source, keys) {
  for (const key of keys) {
    if (isFiniteNumber(source[key])) return source[key];
  }
  return null;
}

async function loadGateStats(options) {
  if (!options.useServer) {
    return { state: "disabled", stats: null, url: null, error: null };
  }
  const base = assertLocalhost(options.serverBaseUrl);
  const url = new URL(GATE_HEALTH_ENDPOINT_PATH, base).toString();
  const response = await httpGetJson(url);
  if (response.state !== "ok") {
    return { state: response.state, stats: null, url, error: response.error };
  }
  const stats = normaliseGateStats(response.payload);
  if (!stats) {
    return { state: "unrecognised-shape", stats: null, url, error: "no killed/passed counters found in the response" };
  }
  return { state: "ok", stats, url, error: null };
}

// ── MTF replay census (optional corroboration) ───────────────────────────────
function extractCensusPayloads(text) {
  const payloads = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.indexOf("MTF_CENSUS ");
    if (marker === -1) continue;
    try {
      payloads.push(JSON.parse(line.slice(marker + "MTF_CENSUS ".length)));
    } catch (parseError) {
      // A truncated census line is not fatal — the ledger side of the report stands.
    }
  }
  return payloads;
}

function loadCensusFromFile(filePath) {
  try {
    const payloads = extractCensusPayloads(fs.readFileSync(filePath, "utf8"));
    if (payloads.length === 0) {
      return { source: filePath, state: "no-census-line", payloads: [], error: "no MTF_CENSUS line in file" };
    }
    return { source: filePath, state: "ok", payloads, error: null };
  } catch (readError) {
    return {
      source: filePath,
      state: readError.code === "ENOENT" ? "missing" : "unreadable",
      payloads: [], error: readError.message,
    };
  }
}

/**
 * Runs tasks/_replay_mtf.cjs. Offline (it reads tasks/history/*.csv) but slow, so it
 * is opt-in. The census goes to stderr. A non-zero exit means engineThrows > 0 — the
 * census is then INCOMPLETE, which reads exactly like "this cohort never traded", so
 * it is reported as degraded and demoted from proof to suspicion.
 */
function runCensus(spec) {
  const label = `${spec.symbol}:${spec.ticker}:${spec.window}`;
  if (!fs.existsSync(REPLAY_SCRIPT_PATH)) {
    return { source: label, state: "missing-replay-script", payloads: [], error: `${REPLAY_SCRIPT_PATH} not found` };
  }
  const child = spawnSync(process.execPath,
    [REPLAY_SCRIPT_PATH, REPO_ROOT, spec.symbol, spec.ticker, String(spec.window)],
    { cwd: REPO_ROOT, timeout: CENSUS_RUN_TIMEOUT_MS, maxBuffer: CENSUS_MAX_STDERR_BYTES, encoding: "utf8" });

  if (child.error) {
    return { source: label, state: "run-failed", payloads: [], error: child.error.message };
  }
  const payloads = extractCensusPayloads(child.stderr || "");
  if (payloads.length === 0) {
    return { source: label, state: "no-census-line", payloads: [],
             error: `the replay produced no MTF_CENSUS line (exit ${child.status})` };
  }
  const degraded = child.status !== 0 || payloads.some((payload) => Number(payload.engineThrows) > 0);
  return {
    source: label, state: degraded ? "degraded" : "ok", payloads,
    error: degraded ? `engineThrows > 0 or non-zero exit (${child.status}) — steps are MISSING from this census` : null,
  };
}

/**
 * A cohort with a real step count that NEVER fired is the census-side equivalent of a
 * gate with kills and zero passes — and here the denominator is exact.
 */
function analyseCensusPayload(payload) {
  const findings = [];
  const census = payload && typeof payload.census === "object" ? payload.census : null;
  if (!census) return findings;
  const tradeThreshold = isFiniteNumber(payload.tradeThreshold) ? payload.tradeThreshold : null;

  for (const [cohort, counters] of Object.entries(census)) {
    if (!counters || typeof counters !== "object") continue;
    const steps = isFiniteNumber(counters.steps) ? counters.steps : 0;
    const fired = isFiniteNumber(counters.fired) ? counters.fired : 0;
    const maxConf = isFiniteNumber(counters.maxConf) ? counters.maxConf : null;
    if (steps < CENSUS_MIN_STEPS || fired > 0) continue;
    // BOTH_WAIT is "no setup formed", not a blocked one — never an alarm (spec §3.1).
    if (cohort === "BOTH_WAIT") continue;

    const clearedThreshold = tradeThreshold !== null && maxConf !== null && maxConf >= tradeThreshold;
    findings.push({
      type: clearedThreshold ? "COHORT_UNREACHABLE" : "COHORT_NEVER_FIRED",
      severity: "CRITICAL",
      confirmed: true,
      scope: `${payload.symbol || "?"} / ${cohort}`,
      steps, fired, maxConf, tradeThreshold,
      band65to74: counters.hist && isFiniteNumber(counters.hist["65-74"]) ? counters.hist["65-74"] : null,
      detail: clearedThreshold
        ? `${steps} steps, 0 fired, maxConf ${maxConf} — confidence CLEARED the replay ` +
          `threshold ${tradeThreshold} and the cohort still never fired. Something above ` +
          `the documented gate is blocking it.`
        : `${steps} steps, 0 fired, maxConf ${maxConf} against replay threshold ${tradeThreshold}.`,
    });
  }
  return findings;
}

// ── findings ─────────────────────────────────────────────────────────────────
/**
 * Turns groups + counters into findings. The pass evidence is what separates a
 * diagnosis from a guess, so it is carried on every finding.
 */
function buildLedgerFindings(groups, gateStats) {
  const findings = [];

  for (const group of groups) {
    const geometry = analyseGroupGeometry(group);
    const kills = group.rows.length;
    const counters = gateStats ? gateStats.get(group.gate) : undefined;
    // Counters reset on restart. Both at zero means "not exercised since the server
    // came up" — no data, NOT a dead gate.
    const hasPassEvidence = counters !== undefined && (counters.killed + counters.passed) > 0;
    const zeroPasses = hasPassEvidence && counters.passed === 0;
    const enoughKills = kills >= MIN_KILLS_FOR_DEAD_GATE
      || (hasPassEvidence && counters.killed >= MIN_KILLS_FOR_DEAD_GATE);

    const base = {
      scope: group.key, gate: group.gate,
      sourceSymbol: group.sourceSymbol, timeframe: group.timeframe,
      kills,
      windowFrom: group.firstTsMs === null ? null : new Date(group.firstTsMs).toISOString(),
      windowTo: group.lastTsMs === null ? null : new Date(group.lastTsMs).toISOString(),
      windowDays: group.firstTsMs === null || group.lastTsMs === null
        ? null : roundTo((group.lastTsMs - group.firstTsMs) / MS_PER_DAY, 2),
      geometry,
      passes: hasPassEvidence ? counters.passed : null,
      serverKills: hasPassEvidence ? counters.killed : null,
    };

    if (zeroPasses && enoughKills) {
      if (geometry.state === "ok" && geometry.hardCeiling) {
        findings.push(Object.assign({}, base, {
          type: "UNREACHABLE", severity: "CRITICAL", confirmed: true,
          detail: unreachableDetail(geometry, kills),
        }));
      } else {
        findings.push(Object.assign({}, base, {
          type: "DEAD_GATE", severity: "CRITICAL", confirmed: true,
          detail: `${kills} kills in the ledger, ${counters.passed} passes against ` +
                  `${counters.killed} kills on the live counter. The gate has never let ` +
                  `anything through since the server started.`,
        }));
      }
    } else if (!hasPassEvidence && enoughKills && geometry.state === "ok" && geometry.hardCeiling) {
      findings.push(Object.assign({}, base, {
        type: "UNREACHABLE_SUSPECTED", severity: "WARN", confirmed: false,
        detail: unreachableDetail(geometry, kills) +
                " No pass counter was available, so this is the SHAPE of an unreachable " +
                "gate, not proof of one — confirm with /api/gate-health or a replay census.",
      }));
    }

    if (geometry.state === "ok"
        && geometry.nearMissRows >= NEAR_MISS_MIN_ROWS
        && geometry.nearMissShare >= NEAR_MISS_MIN_SHARE) {
      findings.push(Object.assign({}, base, {
        type: "NEAR_MISS", severity: "INFO", confirmed: false,
        detail: `${geometry.nearMissRows} of ${geometry.comparableRows} rejections ` +
                `(${Math.round(geometry.nearMissShare * 100)}%) land within ` +
                `${NEAR_MISS_BAND_PCT}% of threshold ${geometry.threshold}. Closest was ` +
                `${geometry.closestActual}. A mispriced constraint hides here.`,
      }));
    }
  }

  // Gates the server says are dead but that have no ledger rows at all — real when a
  // gate kills before the ledger writer runs, or on a box with a fresh ledger.
  if (gateStats) {
    const gatesWithRows = new Set(groups.map((group) => group.gate));
    for (const [gate, counters] of gateStats) {
      if (gatesWithRows.has(gate)) continue;
      if (counters.passed !== 0 || counters.killed < MIN_KILLS_FOR_DEAD_GATE) continue;
      findings.push({
        type: "DEAD_GATE", severity: "CRITICAL", confirmed: true,
        scope: `${gate}|counter-only`, gate, sourceSymbol: null, timeframe: null,
        kills: counters.killed, passes: 0, serverKills: counters.killed,
        windowFrom: null, windowTo: null, windowDays: null,
        geometry: { state: "no-ledger-rows", polarity: "unknown", threshold: null },
        detail: `${counters.killed} kills and 0 passes on the live counter, with no ` +
                `ledger rows for this gate — the gate is dead and is also not logging.`,
      });
    }
  }

  return findings;
}

function unreachableDetail(geometry, kills) {
  const direction = geometry.polarity === "floor" ? "below" : "above";
  return `${kills} kills, 0 passes. The best observation ever recorded is ` +
         `${geometry.closestActual} against a threshold of ${geometry.threshold} — ` +
         `${geometry.shortfall} ${direction} it, ${geometry.shortfallPct}% short, and ` +
         `${geometry.ceilingHits} rejections sit on that exact value. That is a hard cap ` +
         `${direction} the threshold, not a strict gate: the threshold is UNREACHABLE and ` +
         `no amount of market movement can satisfy it.`;
}

// ── report assembly and rendering ────────────────────────────────────────────
function buildReport(context) {
  const { options, ledger, legacy, rowsUsed, gateStatsResult, censusResults, findings, nowMs } = context;
  const degradedReasons = [];
  if (gateStatsResult.state !== "ok") {
    degradedReasons.push(`pass counters unavailable (${gateStatsResult.state}${gateStatsResult.error ? ": " + gateStatsResult.error : ""})`);
  }
  // A supplied census that could not be used is a degradation; not supplying one is
  // not — it is optional corroboration and the pass counters are the real denominator.
  for (const result of censusResults) {
    if (result.state !== "ok") degradedReasons.push(`census ${result.source}: ${result.state}`);
  }
  if (ledger.state !== "ok") degradedReasons.push(`ledger ${ledger.state}`);

  const confirmedUnreachable = findings.filter(
    (finding) => finding.confirmed && (finding.type === "UNREACHABLE"
      || finding.type === "COHORT_UNREACHABLE" || finding.type === "COHORT_NEVER_FIRED")
  );
  const suspectedUnreachable = findings.filter((finding) => finding.type === "UNREACHABLE_SUSPECTED");
  const deadGates = findings.filter((finding) => finding.type === "DEAD_GATE");
  const nearMisses = findings.filter((finding) => finding.type === "NEAR_MISS");

  return {
    tool: "gate_health",
    generatedAt: new Date(nowMs).toISOString(),
    mode: degradedReasons.length > 0 ? "DEGRADED" : "FULL",
    degradedReasons,
    inputs: {
      ledger: summariseLedger(ledger),
      legacy: options.useLegacy ? summariseLedger(legacy) : { path: legacy.path, state: "disabled" },
      rowsAnalysed: rowsUsed.length,
      windowDays: options.days,
      gateHealth: { url: gateStatsResult.url, state: gateStatsResult.state, error: gateStatsResult.error,
                    gates: gateStatsResult.stats ? Object.fromEntries(gateStatsResult.stats) : null },
      census: censusResults.map((result) => ({ source: result.source, state: result.state, error: result.error })),
    },
    summary: {
      unreachableConfirmed: confirmedUnreachable.length,
      unreachableSuspected: suspectedUnreachable.length,
      deadGates: deadGates.length,
      nearMisses: nearMisses.length,
    },
    findings,
  };
}

function summariseLedger(ledger) {
  return {
    path: ledger.path, state: ledger.state, lines: ledger.totalLines,
    rows: ledger.rows.length, malformedLines: ledger.malformedLines,
    unusableRows: ledger.unusableRows,
    unknownGates: Object.keys(ledger.unknownGates).length > 0 ? ledger.unknownGates : null,
    error: ledger.error,
  };
}

const LEDGER_STATE_MESSAGES = {
  missing: "does not exist yet — nothing has been logged on this box",
  empty: "exists but is empty — the writer has run and nothing has been rejected yet",
  unreadable: "could not be read",
  disabled: "skipped by --no-legacy",
};

function renderText(report) {
  const lines = [];
  const push = (line) => lines.push(line);

  push("=".repeat(78));
  push(`GATE HEALTH — ${report.generatedAt}   MODE: ${report.mode}`);
  push("=".repeat(78));

  for (const [label, summary] of [["ledger", report.inputs.ledger], ["legacy", report.inputs.legacy]]) {
    const note = LEDGER_STATE_MESSAGES[summary.state];
    push(`${label.padEnd(7)} ${summary.path}`);
    push(`        ${note ? note : `${summary.rows} usable rows of ${summary.lines} lines`}` +
         `${summary.malformedLines ? `, ${summary.malformedLines} malformed line(s) skipped` : ""}` +
         `${summary.unusableRows ? `, ${summary.unusableRows} row(s) missing a gate` : ""}`);
    if (summary.unknownGates) {
      push(`        unknown gate names: ${JSON.stringify(summary.unknownGates)}`);
    }
  }

  const gateHealth = report.inputs.gateHealth;
  push(`server  ${gateHealth.url || "(skipped)"}`);
  push(`        ${gateHealth.state}${gateHealth.error ? ` — ${gateHealth.error}` : ""}`);
  for (const census of report.inputs.census) {
    push(`census  ${census.source} — ${census.state}${census.error ? ` — ${census.error}` : ""}`);
  }
  push(`rows analysed: ${report.inputs.rowsAnalysed}` +
       `${report.inputs.windowDays ? ` (last ${report.inputs.windowDays} days)` : ""}`);

  if (report.mode === "DEGRADED") {
    push("");
    push("DEGRADED — this is a PARTIAL answer:");
    for (const reason of report.degradedReasons) push(`  - ${reason}`);
    push("  A ledger holds rejections only, so 'no observation ever reached the threshold'");
    push("  is true of every healthy gate too. Without a pass counter or a replay census");
    push("  the only ledger-side evidence is the SHAPE of the rejected distribution.");
  }

  const order = { CRITICAL: 0, WARN: 1, INFO: 2 };
  const sorted = [...report.findings].sort(
    (a, b) => (order[a.severity] - order[b.severity]) || String(a.scope).localeCompare(String(b.scope))
  );

  push("");
  if (sorted.length === 0) {
    push("No dead, unreachable or near-miss gates found in the evidence available.");
  }
  for (const finding of sorted) {
    push("-".repeat(78));
    push(`[${finding.severity}] ${finding.type}  ${finding.scope}`);
    if (finding.windowFrom) {
      push(`  window: ${finding.windowFrom} .. ${finding.windowTo} (${finding.windowDays} days)`);
    }
    if (isFiniteNumber(finding.kills)) {
      push(`  kills: ${finding.kills}   passes: ${finding.passes === null ? "UNKNOWN" : finding.passes}` +
           `${finding.serverKills === null ? "" : `   (live counter: ${finding.serverKills} killed)`}`);
    }
    if (finding.geometry && finding.geometry.state === "ok") {
      push(`  threshold: ${finding.geometry.threshold}   best actual ever seen: ${finding.geometry.closestActual}` +
           `   short by: ${finding.geometry.shortfall} (${finding.geometry.shortfallPct}%)`);
      push(`  ceiling hits at ${finding.geometry.closestActual}: ${finding.geometry.ceilingHits}` +
           ` of ${finding.geometry.comparableRows}   thresholds seen: ${JSON.stringify(finding.geometry.thresholdsSeen)}`);
    }
    if (isFiniteNumber(finding.steps)) {
      push(`  census: ${finding.steps} steps, ${finding.fired} fired, maxConf ${finding.maxConf}` +
           `${finding.band65to74 === null ? "" : `, ${finding.band65to74} steps in the 65-74 band`}`);
    }
    push(`  ${finding.detail}`);
  }

  push("-".repeat(78));
  push(`SUMMARY  unreachable(confirmed)=${report.summary.unreachableConfirmed}` +
       `  unreachable(suspected)=${report.summary.unreachableSuspected}` +
       `  dead=${report.summary.deadGates}  near-miss=${report.summary.nearMisses}`);
  return lines.join("\n");
}

function decideExitCode(report, alarmOnDead) {
  if (report.summary.unreachableConfirmed > 0) return EXIT_UNREACHABLE_CONFIRMED;
  if (alarmOnDead && report.summary.deadGates > 0) return EXIT_UNREACHABLE_CONFIRMED;
  if (report.summary.unreachableSuspected > 0) return EXIT_UNREACHABLE_SUSPECTED;
  return EXIT_OK;
}

const HELP_TEXT = `gate_health — find gates that kill constantly and never pass.

  node tasks/gate_health.cjs [options]

  --ledger <path>       rejection ledger (default tasks/rejections.jsonl)
  --legacy <path>       frozen MIN_RR ledger (default tasks/rr_rejected.jsonl)
  --no-legacy           ignore the legacy ledger
  --server <baseUrl>    localhost only (default ${DEFAULT_SERVER_BASE_URL})
  --no-server           skip /api/gate-health; degraded, ledger-only
  --days <n>            only rejections from the last n days
  --census-file <path>  file containing an MTF_CENSUS line (repeatable)
  --run-census <S:T[:W]>  run tasks/_replay_mtf.cjs offline (repeatable, ~60s each)
  --alarm-on-dead       exit ${EXIT_UNREACHABLE_CONFIRMED} for a dead gate even without cap geometry
  --json                machine-readable report on stdout
  --out <path>          write the JSON report (tasks/analysis/ or tasks/logs/ only)

  exit ${EXIT_OK} clean   ${EXIT_USAGE} tool error   ${EXIT_UNREACHABLE_CONFIRMED} unreachable confirmed   ${EXIT_UNREACHABLE_SUSPECTED} unreachable suspected`;

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.outPath) options.outPath = assertOutputPathAllowed(options.outPath);
  } catch (argError) {
    process.stderr.write(`gate_health: ${argError.message}\n\n${HELP_TEXT}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return EXIT_OK;
  }

  const nowMs = Date.now();
  const ledger = readLedgerFile(options.ledgerPath, normaliseCurrentRow);
  const legacy = options.useLegacy
    ? readLedgerFile(options.legacyPath, normaliseLegacyRow)
    : { path: options.legacyPath, state: "disabled", rows: [], totalLines: 0,
        malformedLines: 0, unusableRows: 0, unknownGates: {}, error: null };

  const allRows = ledger.rows.concat(legacy.rows);
  const { rows: rowsUsed } = filterRowsByAge(allRows, options.days, nowMs);

  let gateStatsResult;
  try {
    gateStatsResult = await loadGateStats(options);
  } catch (serverError) {
    process.stderr.write(`gate_health: ${serverError.message}\n`);
    return EXIT_USAGE;
  }

  const censusResults = [];
  for (const filePath of options.censusFiles) censusResults.push(loadCensusFromFile(filePath));
  for (const spec of options.censusRuns) censusResults.push(runCensus(spec));

  const groups = groupRejections(rowsUsed);
  const findings = buildLedgerFindings(groups, gateStatsResult.stats);
  for (const result of censusResults) {
    if (result.state !== "ok" && result.state !== "degraded") continue;
    for (const payload of result.payloads) {
      for (const finding of analyseCensusPayload(payload)) {
        // A degraded census has steps missing; it can suggest, never confirm.
        if (result.state === "degraded") {
          finding.confirmed = false;
          finding.severity = "WARN";
          finding.type = "COHORT_NEVER_FIRED_SUSPECTED";
          finding.detail += " Census DEGRADED (engineThrows > 0) — steps are missing, so this is not a complete measurement.";
        }
        findings.push(finding);
      }
    }
  }

  const report = buildReport({ options, ledger, legacy, rowsUsed, gateStatsResult, censusResults, findings, nowMs });

  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : renderText(report)}\n`);

  if (options.outPath) {
    try {
      fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
      fs.writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (writeError) {
      process.stderr.write(`gate_health: could not write ${options.outPath}: ${writeError.message}\n`);
      return EXIT_USAGE;
    }
  }

  return decideExitCode(report, options.alarmOnDead);
}

main()
  .then((exitCode) => { process.exitCode = exitCode; })
  .catch((unexpectedError) => {
    // Nothing here should throw; if it does, a scheduled run must see a real message.
    process.stderr.write(`gate_health: unexpected failure: ${unexpectedError && unexpectedError.stack}\n`);
    process.exitCode = EXIT_USAGE;
  });
