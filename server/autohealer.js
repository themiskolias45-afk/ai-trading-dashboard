'use strict';
const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

// ── Self-healing watchdog for SmartEntry Pro ────────────────────────────────
// Monitors internal state every 30s. Detects stale data, failed fetches,
// crashed subsystems. Retries failed ops. Alerts + restarts on critical failure.

const STALE_SIGNAL_MS  = 6 * 60 * 60 * 1000;  // 6 hours
const STALE_PRICE_MS   = 10 * 60 * 1000;       // 10 minutes
const STALE_MT5_MS     = 3 * 60 * 1000;        // 3 minutes — 3x the default 60s bridge poll interval
const MAX_RETRY        = 3;
const HEAL_INTERVAL_MS = 30 * 1000;

const LEARNING_FILE = path.join(__dirname, 'learning.json');
const JOURNAL_FILE  = path.join(__dirname, 'journal.json');

// Which bridge accounts MUST be reporting for this deployment to be complete.
//
// This exists because the healer used to derive the account list from
// mt5LastSeenByAccount, which only ever contains accounts that have reported at
// least once. An account that failed its very first connection was therefore not
// in the object, not in the denominator, and completely invisible: the VPS ran
// for weeks with Bridge B dead while this check cheerfully reported
// "1/1 account(s) reporting" and healthy:true. Counting only what showed up can
// never detect what never showed up — the expected set has to be declared.
//
// Drop an account from the list when you deliberately disable its bridge, so a
// planned shutdown doesn't read as a fault. The default describes the system as
// designed (mirrored dual-account); any deviation is opt-in and visible.
const EXPECTED_MT5_ACCOUNTS = (process.env.MT5_EXPECTED_ACCOUNTS ?? 'A,B')
  .split(',')
  .map(tag => tag.trim())
  .filter(Boolean);

// A cold boot legitimately has no heartbeats yet: the MT5 terminal has to launch
// and the bridge burns up to 6 retries at 15s apart before its first post. Matches
// MT5_NEVER_CONNECTED_GRACE_MS in server/index.js — keep the two in step.
const MT5_STARTUP_GRACE_MS = 5 * 60 * 1000;

const state = {
  healCount:   0,
  lastHealAt:  null,
  errorLog:    [],    // last 50 errors
  retryQueue:  [],    // ops waiting to retry
  healthy:     true,
  checks:      {
    signalFreshness: { ok: true, lastChecked: null, detail: null },
    priceFreshness:  { ok: true, lastChecked: null, detail: null },
    learningFile:    { ok: true, lastChecked: null, detail: null },
    journalFile:     { ok: true, lastChecked: null, detail: null },
    memory:          { ok: true, lastChecked: null, detail: null },
    errorRate:       { ok: true, lastChecked: null, detail: null },
    mt5Bridge:       { ok: true, lastChecked: null, detail: null },
  },
};

let mt5AlertSent = false; // avoid re-alerting every 30s while the bridge stays down

// Server context injected via start()
let ctx = null;

// Interval handle — kept so tests / forced restarts can clear it
let healInterval = null;

// ── Logging ────────────────────────────────────────────────────────────────

function logError(msg) {
  const entry = { ts: new Date().toISOString(), msg };
  state.errorLog.unshift(entry);
  if (state.errorLog.length > 50) state.errorLog.pop();
  console.error('[HEALER]', msg);
}

function recordHeal(what) {
  state.healCount++;
  state.lastHealAt = new Date().toISOString();
  console.log('[HEALER] Healed:', what, '| Total heals:', state.healCount);
}

function updateCheck(name, ok, detail) {
  if (!state.checks[name]) return;
  state.checks[name].ok          = ok;
  state.checks[name].lastChecked = new Date().toISOString();
  state.checks[name].detail      = detail ?? null;
}

// ── Backup helpers ─────────────────────────────────────────────────────────

/**
 * Write a .bak copy of a JSON file before it is modified.
 * Silently skips if the source does not exist yet.
 */
function writeBackup(filePath) {
  const bakPath = filePath + '.bak';
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
      console.log('[HEALER] Backup written:', bakPath);
    }
  } catch (err) {
    logError(`Backup write failed for ${path.basename(filePath)}: ${err.message}`);
  }
}

/**
 * Attempt to restore a JSON file from its .bak copy.
 * Returns the parsed object on success, null on failure.
 */
function restoreFromBackup(filePath) {
  const bakPath = filePath + '.bak';
  try {
    if (!fs.existsSync(bakPath)) {
      logError(`No backup found for ${path.basename(filePath)} — cannot restore`);
      return null;
    }
    const raw  = fs.readFileSync(bakPath, 'utf8');
    const data = JSON.parse(raw);                    // validate that the backup is itself valid JSON
    fs.copyFileSync(bakPath, filePath);
    console.log('[HEALER] Restored', path.basename(filePath), 'from backup');
    recordHeal(`restored ${path.basename(filePath)} from .bak`);
    return data;
  } catch (err) {
    logError(`Backup restore failed for ${path.basename(filePath)}: ${err.message}`);
    return null;
  }
}

/**
 * Safely parse a JSON file.
 * Returns { data, corrupt } where corrupt=true means the file exists but is not valid JSON.
 */
function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return { data: null, corrupt: false };
  try {
    const raw  = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return { data, corrupt: false };
  } catch (_) {
    return { data: null, corrupt: true };
  }
}

// ── withRetry ──────────────────────────────────────────────────────────────

/**
 * Wraps an async function with exponential-backoff retry logic.
 *
 * @param {() => Promise<any>} fn       - Async function to execute.
 * @param {string}             label    - Human-readable name for logging.
 * @param {number}             maxTries - Maximum attempts (default: MAX_RETRY).
 * @returns {Promise<any>}              - Resolves with fn's return value, rejects if all retries fail.
 */
async function withRetry(fn, label, maxTries = MAX_RETRY) {
  if (typeof fn !== 'function') throw new TypeError(`withRetry: fn must be a function, got ${typeof fn}`);
  if (!label) label = 'unnamed-op';

  const delays = [2000, 4000, 8000];   // 2s → 4s → 8s

  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        // Recovered after at least one retry
        recordHeal(`${label} succeeded on attempt ${attempt}`);
        state.healthy = true;
      }
      return result;
    } catch (err) {
      lastErr = err;
      logError(`${label} attempt ${attempt}/${maxTries} failed: ${err.message}`);
      if (attempt < maxTries) {
        const delay = delays[attempt - 1] ?? 8000;
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  logError(`${label} failed after ${maxTries} attempts — marking unhealthy`);
  state.healthy = false;
  throw lastErr;
}

// ── Individual health checks ───────────────────────────────────────────────

async function checkSignalFreshness() {
  const name = 'signalFreshness';
  try {
    const cache = ctx && ctx.signalCache ? ctx.signalCache : null;

    if (!cache) {
      updateCheck(name, true, 'signalCache not available in context');
      return;
    }

    const updatedAt = cache.updatedAt;
    if (!updatedAt) {
      // Cache exists but was never populated — trigger a refresh
      updateCheck(name, false, 'signalCache has never been populated');
      if (typeof ctx.refreshSignals === 'function') {
        await withRetry(() => ctx.refreshSignals(), 'refreshSignals');
        updateCheck(name, true, 'signals refreshed (was unpopulated)');
      }
      return;
    }

    const ageMs = Date.now() - new Date(updatedAt).getTime();
    if (ageMs > STALE_SIGNAL_MS) {
      const ageHrs = (ageMs / 3_600_000).toFixed(1);
      updateCheck(name, false, `signal cache is ${ageHrs}h old (limit 6h)`);
      if (typeof ctx.refreshSignals === 'function') {
        await withRetry(() => ctx.refreshSignals(), 'refreshSignals');
        updateCheck(name, true, 'signals refreshed after staleness');
        recordHeal(`stale signal cache refreshed (was ${ageHrs}h old)`);
      }
    } else {
      updateCheck(name, true, `signal cache age ${(ageMs / 60_000).toFixed(1)}min`);
    }
  } catch (err) {
    updateCheck(name, false, err.message);
    logError(`checkSignalFreshness: ${err.message}`);
  }
}

async function checkPriceFreshness() {
  const name = 'priceFreshness';
  try {
    const cache = ctx && ctx.priceCache ? ctx.priceCache : null;

    if (!cache) {
      updateCheck(name, true, 'priceCache not available in context');
      return;
    }

    const updated = cache.updated;
    if (!updated) {
      updateCheck(name, false, 'priceCache has never been populated');
      if (typeof ctx.fetchPrices === 'function') {
        await withRetry(() => ctx.fetchPrices(), 'fetchPrices');
        updateCheck(name, true, 'prices fetched (was unpopulated)');
      }
      return;
    }

    const ageMs = Date.now() - new Date(updated).getTime();
    if (ageMs > STALE_PRICE_MS) {
      const ageMin = (ageMs / 60_000).toFixed(1);
      updateCheck(name, false, `price cache is ${ageMin}min old (limit 10min)`);
      if (typeof ctx.fetchPrices === 'function') {
        await withRetry(() => ctx.fetchPrices(), 'fetchPrices');
        updateCheck(name, true, 'prices refreshed after staleness');
        recordHeal(`stale price cache refreshed (was ${ageMin}min old)`);
      }
    } else {
      updateCheck(name, true, `price cache age ${(ageMs / 60_000).toFixed(1)}min`);
    }
  } catch (err) {
    updateCheck(name, false, err.message);
    logError(`checkPriceFreshness: ${err.message}`);
  }
}

function checkMt5Bridge() {
  const name = 'mt5Bridge';
  try {
    const lastSeen = ctx && ctx.mt5LastSeenByAccount ? ctx.mt5LastSeenByAccount : {};
    const accounts = Object.entries(lastSeen);

    if (accounts.length === 0) {
      updateCheck(name, true, 'no bridge has connected yet this session');
      return;
    }

    const now = Date.now();
    const ages = accounts.map(([account, ts]) => ({ account, ageMs: now - new Date(ts).getTime() }));
    const live = ages.filter(a => a.ageMs < STALE_MT5_MS);

    if (live.length > 0) {
      updateCheck(name, true, `${live.length}/${ages.length} account(s) reporting`);
      if (mt5AlertSent) {
        mt5AlertSent = false;
        console.log('[HEALER] MT5 bridge heartbeat recovered');
      }
    } else {
      const staleList = ages.map(a => `${a.account} (${Math.round(a.ageMs / 1000)}s ago)`).join(', ');
      updateCheck(name, false, `no bridge heartbeat — ${staleList}`);
      if (!mt5AlertSent) {
        sendAlert(`MT5 bridge has gone silent (${staleList}) — no trades will execute until it's restarted.`);
        mt5AlertSent = true;
      }
    }
  } catch (err) {
    updateCheck(name, false, err.message);
    logError(`checkMt5Bridge: ${err.message}`);
  }
}

function checkLearningFile() {
  const name = 'learningFile';
  try {
    const { data, corrupt } = safeReadJson(LEARNING_FILE);
    if (!corrupt) {
      updateCheck(name, true, data ? `${Object.keys(data.setupStats || {}).length} setups on disk` : 'file absent (normal on first run)');
      return;
    }

    // File is corrupt — attempt restore
    logError('learning.json is corrupt — attempting restore from backup');
    updateCheck(name, false, 'learning.json corrupt');
    const restored = restoreFromBackup(LEARNING_FILE);
    if (restored) {
      // Push the restored data back into the server context if possible
      if (ctx && ctx.learning) Object.assign(ctx.learning, restored);
      updateCheck(name, true, 'learning.json restored from backup');
    } else {
      // No backup — write a clean default so the server keeps running
      const defaultLearning = { setupStats: {}, sessionCount: 0, updatedAt: new Date().toISOString() };
      fs.writeFileSync(LEARNING_FILE, JSON.stringify(defaultLearning, null, 2));
      if (ctx && ctx.learning) Object.assign(ctx.learning, defaultLearning);
      updateCheck(name, true, 'learning.json reset to defaults (no backup available)');
      recordHeal('learning.json reset to defaults after corruption with no backup');
    }
  } catch (err) {
    updateCheck(name, false, err.message);
    logError(`checkLearningFile: ${err.message}`);
  }
}

function checkJournalFile() {
  const name = 'journalFile';
  try {
    const { data, corrupt } = safeReadJson(JOURNAL_FILE);
    if (!corrupt) {
      const count = Array.isArray(data) ? data.length : 0;
      updateCheck(name, true, data ? `${count} journal entries on disk` : 'file absent (normal on first run)');
      return;
    }

    // File is corrupt — attempt restore
    logError('journal.json is corrupt — attempting restore from backup');
    updateCheck(name, false, 'journal.json corrupt');
    const restored = restoreFromBackup(JOURNAL_FILE);
    if (restored) {
      if (ctx && Array.isArray(ctx.tradeJournal) && Array.isArray(restored)) {
        ctx.tradeJournal.length = 0;
        ctx.tradeJournal.push(...restored);
      }
      updateCheck(name, true, 'journal.json restored from backup');
    } else {
      // No backup — write an empty journal so the server keeps running
      fs.writeFileSync(JOURNAL_FILE, JSON.stringify([], null, 2));
      if (ctx && Array.isArray(ctx.tradeJournal)) ctx.tradeJournal.length = 0;
      updateCheck(name, true, 'journal.json reset to empty array (no backup available)');
      recordHeal('journal.json reset to [] after corruption with no backup');
    }
  } catch (err) {
    updateCheck(name, false, err.message);
    logError(`checkJournalFile: ${err.message}`);
  }
}

// Node can't reduce its own heap on demand — the only real fix for a genuine leak is a
// restart. This doesn't restart itself directly (no supervisor access from in-process);
// it exits cleanly and lets the already-running watchdog (tested working on both the
// local machine and the VPS) detect the outage and relaunch via Scheduled Tasks, same
// path as any other crash. Requires 3 consecutive critical checks (~90s sustained, since
// this runs every 30s) before acting, so a single GC-pause spike doesn't trigger a restart.
let consecutiveCriticalMemoryHits = 0;
const CRITICAL_MEMORY_RESTART_THRESHOLD = 3;

function checkMemory() {
  const name = 'memory';
  try {
    const { heapUsed, rss } = process.memoryUsage();
    const heapMB = heapUsed / 1_048_576;
    const rssMB  = rss       / 1_048_576;

    const WARNING_MB  = 500;
    const CRITICAL_MB = 900;

    if (heapMB > CRITICAL_MB) {
      consecutiveCriticalMemoryHits++;
      updateCheck(name, false, `CRITICAL heap usage: ${heapMB.toFixed(0)}MB (${consecutiveCriticalMemoryHits}/${CRITICAL_MEMORY_RESTART_THRESHOLD} before restart)`);
      logError(`CRITICAL memory: heap=${heapMB.toFixed(0)}MB rss=${rssMB.toFixed(0)}MB`);

      if (consecutiveCriticalMemoryHits >= CRITICAL_MEMORY_RESTART_THRESHOLD) {
        logError(`Memory critical for ${consecutiveCriticalMemoryHits} consecutive checks — exiting cleanly so the watchdog restarts the process.`);
        sendAlert(`SmartEntry Pro restarting itself — sustained critical memory usage (${heapMB.toFixed(0)}MB heap). The watchdog will bring it back up within ~60s.`);
        setTimeout(() => process.exit(1), 500); // brief delay so the alert/log actually flush before exit
      }
    } else if (heapMB > WARNING_MB) {
      consecutiveCriticalMemoryHits = 0;
      updateCheck(name, false, `HIGH heap usage: ${heapMB.toFixed(0)}MB (warning > ${WARNING_MB}MB)`);
      logError(`HIGH memory usage: heap=${heapMB.toFixed(0)}MB rss=${rssMB.toFixed(0)}MB`);
    } else {
      consecutiveCriticalMemoryHits = 0;
      updateCheck(name, true, `heap=${heapMB.toFixed(0)}MB rss=${rssMB.toFixed(0)}MB`);
    }
  } catch (err) {
    updateCheck(name, false, err.message);
    logError(`checkMemory: ${err.message}`);
  }
}

function checkErrorRate() {
  const name = 'errorRate';
  const WINDOW_MS    = 5 * 60 * 1000;   // 5-minute window
  const ERROR_LIMIT  = 10;

  try {
    const cutoff   = Date.now() - WINDOW_MS;
    const recent   = state.errorLog.filter(e => new Date(e.ts).getTime() >= cutoff);
    const count    = recent.length;

    if (count > ERROR_LIMIT) {
      updateCheck(name, false, `${count} errors in last 5min (limit ${ERROR_LIMIT})`);
      sendAlert(`SmartEntry Pro: ${count} errors in the last 5 minutes — check logs`);
    } else {
      updateCheck(name, true, `${count} errors in last 5min`);
    }
  } catch (err) {
    updateCheck(name, false, err.message);
    logError(`checkErrorRate: ${err.message}`);
  }
}

// ── Alert dispatch ─────────────────────────────────────────────────────────

/**
 * Send a Telegram alert if the bot token + chat ID are available in context.
 * Fire-and-forget — never throws.
 */
function sendAlert(message) {
  console.warn('[HEALER] ALERT:', message);

  if (!ctx) return;
  const token  = ctx.TELEGRAM_TOKEN;
  const chatId = ctx.alertChatId || (ctx.knownChatIds && [...ctx.knownChatIds][0]);

  if (!token || !chatId) return;  // No telegram configured — log only

  const body = JSON.stringify({ chat_id: chatId, text: `[SmartEntry Healer] ${message}` });
  const opts = {
    hostname: 'api.telegram.org',
    path:     `/bot${token}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };

  const req = https.request(opts, (res) => {
    if (res.statusCode !== 200) {
      logError(`Telegram alert failed: HTTP ${res.statusCode}`);
    }
  });
  req.on('error', (err) => logError(`Telegram alert error: ${err.message}`));
  req.setTimeout(5000, () => { req.destroy(); });
  req.write(body);
  req.end();
}

// ── Main heal cycle ────────────────────────────────────────────────────────

async function runHealCycle() {
  const start = Date.now();
  let anyFail = false;

  // Run sync checks first
  try { checkMemory();    } catch (e) { logError(`checkMemory threw: ${e.message}`);    anyFail = true; }
  try { checkErrorRate(); } catch (e) { logError(`checkErrorRate threw: ${e.message}`); anyFail = true; }
  try { checkLearningFile(); } catch (e) { logError(`checkLearningFile threw: ${e.message}`); anyFail = true; }
  try { checkJournalFile();  } catch (e) { logError(`checkJournalFile threw: ${e.message}`);  anyFail = true; }
  try { checkMt5Bridge();    } catch (e) { logError(`checkMt5Bridge threw: ${e.message}`);    anyFail = true; }

  // Run async checks sequentially (they may trigger network calls)
  try { await checkSignalFreshness(); } catch (e) { logError(`checkSignalFreshness threw: ${e.message}`); anyFail = true; }
  try { await checkPriceFreshness();  } catch (e) { logError(`checkPriceFreshness threw: ${e.message}`);  anyFail = true; }

  // Derive overall health from individual check results
  const allChecksOk = Object.values(state.checks).every(c => c.ok);
  state.healthy = allChecksOk && !anyFail;

  const elapsed = Date.now() - start;
  if (elapsed > 10_000) {
    logError(`Heal cycle took ${elapsed}ms — network may be slow`);
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the monitoring loop.
 *
 * @param {object} serverContext - References to live server state:
 *   {
 *     signalCache:     object   — { updatedAt: ISO string, ... }
 *     priceCache:      object   — { updated: ISO string, ... }
 *     learning:        object   — the learning state object
 *     tradeJournal:    Array    — the live trade-journal array
 *     mt5LastSeenByAccount: object — account tag -> ISO timestamp of last bridge heartbeat
 *     refreshSignals:  Function — async () => void
 *     fetchPrices:     Function — async () => void
 *     TELEGRAM_TOKEN:  string   — optional, for alerts
 *     knownChatIds:    Set      — optional, for Telegram chat routing
 *     alertChatId:     string   — optional, explicit alert recipient
 *   }
 */
function start(serverContext) {
  if (!serverContext || typeof serverContext !== 'object') {
    throw new TypeError('autohealer.start() requires a serverContext object');
  }

  ctx = serverContext;

  if (healInterval) {
    clearInterval(healInterval);
    healInterval = null;
  }

  // Run an immediate cycle so we know state before the first 30s tick
  runHealCycle().catch(err => logError(`Initial heal cycle error: ${err.message}`));

  healInterval = setInterval(() => {
    runHealCycle().catch(err => logError(`Scheduled heal cycle error: ${err.message}`));
  }, HEAL_INTERVAL_MS);

  // Don't prevent the process from exiting if nothing else is running
  if (healInterval.unref) healInterval.unref();

  console.log('[HEALER] Started — monitoring every', HEAL_INTERVAL_MS / 1000, 'seconds');
}

/**
 * Returns a snapshot of the current healer state.
 *
 * @returns {{ healthy: boolean, healCount: number, lastHealAt: string|null, errorLog: Array, checks: object }}
 */
function getStatus() {
  return {
    healthy:    state.healthy,
    healCount:  state.healCount,
    lastHealAt: state.lastHealAt,
    errorLog:   state.errorLog.slice(),        // shallow copy — caller-safe
    checks:     JSON.parse(JSON.stringify(state.checks)),  // deep copy
  };
}

/**
 * Immediately runs a full heal cycle outside the regular schedule.
 * Returns the status snapshot after the cycle completes.
 *
 * @returns {Promise<object>}
 */
async function forceHeal() {
  console.log('[HEALER] Force-heal triggered');
  await runHealCycle();
  return getStatus();
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  start,
  getStatus,
  forceHeal,
  withRetry,
  // Expose backup helpers so server/index.js can call them before writing files
  writeBackup,
  restoreFromBackup,
};
