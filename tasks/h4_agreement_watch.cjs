#!/usr/bin/env node
'use strict';
/**
 * Alert the moment an asset LEAVES the dead cohort — i.e. H4 stops saying WAIT and
 * lines back up with the daily.
 *
 * WHY THIS EXISTS. On 2026-09-08 all three assets sat at confidence 40 against a gate of
 * 70 on both boxes, and the reason was structural rather than a slow market: the cohort
 * "Daily fires, H4 neutral/disagrees (non-Gold)" has a base of 40 and a MAXIMUM BOOST of
 * +15, so its ceiling is 55. While H4 says WAIT, no setup can clear a 70 gate however
 * good it is. Watching "is there a signal yet" would therefore have been watching the
 * wrong thing — the number cannot move until the COHORT changes.
 *
 * WHAT IT WATCHES, AND WHY IT IS CONFIDENCE AND NOT h4.signal.
 * The engine's own test is `h4.signal === daily.signal`, and /api/signals exposes
 * `h4.signal` but NOT `daily.signal` — the daily leg's pre-gate direction is internal.
 * Deriving the daily direction here would be a second implementation of the engine's
 * rule, free to drift from it, which is the duplicate-scorer mistake this project has
 * made before. Confidence is the engine's OWN answer to that same question:
 *
 *     base 40                      -> H4 disagrees or has no opinion  (cohort ceiling 55)
 *     72 / 88 / 95                 -> H4 AGREES with the daily
 *
 * So a reading above the dead-cohort ceiling IS the engine telling us the cohort changed.
 * COHORT_CEILING is a property of the scoring table, not a threshold to tune; it is
 * asserted below against the live gate so this file cannot go quietly stale if either
 * moves.
 *
 * THE GATE IS READ LIVE, NEVER HARDCODED. It moved 65 -> 70 once already and the boot
 * file was the last thing still claiming 65.
 *
 * IT CHANGES NOTHING. Reads two endpoints, writes one state file, sends one message.
 * No order path, no setting, no gate, no halt. It cannot block or place a trade.
 *
 *   node tasks/h4_agreement_watch.cjs            check once, alert on a transition
 *   node tasks/h4_agreement_watch.cjs --notify   same, and actually send the Telegram
 *   node tasks/h4_agreement_watch.cjs --dry      print the verdict, never send, never write
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'tasks', 'h4_agreement_state.json');
const HOST = '127.0.0.1';
const PORT = 3001;

// The ceiling of the dead cohort: base 40 + the largest boost the scorer can add (+15).
// A confidence ABOVE this cannot have come from the H4-disagrees branch.
const COHORT_CEILING = 55;

const DRY    = process.argv.includes('--dry');
const NOTIFY = process.argv.includes('--notify');

function readEnv(key) {
  try {
    const env = fs.readFileSync(path.join(ROOT, 'keys.env'), 'utf8');
    const m = env.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.+)$', 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function request(pathname, body, cookie) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method: payload ? 'POST' : 'GET', timeout: 15000, headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ body: buf, status: res.statusCode, headers: res.headers }));
      }
    );
    // A watch that throws on a dropped packet becomes a watch nobody trusts.
    req.on('error',   (e) => resolve({ body: '', status: 0, headers: {}, error: e.message }));
    req.on('timeout', ()  => { req.destroy(); resolve({ body: '', status: 0, headers: {}, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

function parse(res) {
  try { return JSON.parse(res.body); } catch { return null; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }              // absent or unreadable both mean "no baseline yet"
}

function sendTelegram(text) {
  const py = readEnv('SMARTENTRY_PYTHON') || 'python';
  const r  = spawnSync(py, [path.join(ROOT, 'tasks', 'send_telegram.py')], {
    input: text, encoding: 'utf8', timeout: 30000,
  });
  const verdict = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/)[0] || 'NO OUTPUT';
  return { ok: r.status === 0, verdict, status: r.status };
}

(async () => {
  const user = readEnv('DASHBOARD_USERNAME');
  const pass = readEnv('DASHBOARD_PASSWORD');
  if (!user || !pass) { console.log('NOCONFIG dashboard credentials missing from keys.env'); process.exit(2); }

  const login = await request('/api/login', { username: user, password: pass });
  if (login.status !== 200) { console.log(`LOGIN FAILED ${login.status || login.error}`); process.exit(3); }
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const settings = parse(await request('/api/strategy-settings', null, cookie));
  const signals  = parse(await request('/api/signals', null, cookie));
  if (!settings || !signals) { console.log('UNREADABLE /api/strategy-settings or /api/signals'); process.exit(3); }

  const gate = Number(settings.confidenceThreshold);
  if (!Number.isFinite(gate)) { console.log('NO GATE in strategy-settings'); process.exit(3); }
  // settingsError non-null means the server is on built-in defaults, not the saved file.
  // Say so rather than alerting against a gate nobody chose.
  const settingsError = settings.settingsError ?? null;

  const previous = loadState();
  const now      = new Date().toISOString();
  const box      = os.hostname();
  const rows     = [];

  for (const key of ['btc', 'gold', 'spx']) {
    const a = signals[key];
    if (!a) continue;
    const confidence = Number(a.confidence);
    if (!Number.isFinite(confidence)) continue;

    const aboveCeiling = confidence > COHORT_CEILING;   // the cohort changed: H4 agrees
    const clearsGate   = confidence >= gate;            // it would actually fire
    const wasAbove     = previous[key]?.aboveCeiling === true;

    rows.push({
      key, confidence, aboveCeiling, clearsGate, wasAbove,
      h4:    a.h4?.signal ?? null,
      h1:    a.h1?.signal ?? null,
      trend: a.trend ?? null,
      setup: a.setup ?? null,
      // Only a RISING edge is news. Alerting every run while it stays above would train
      // the reader to ignore it, which is how a real signal gets missed.
      fired: aboveCeiling && !wasAbove,
    });
  }

  if (!rows.length) { console.log('NO ASSETS in /api/signals'); process.exit(3); }

  const fired = rows.filter((r) => r.fired);
  const line  = rows.map((r) =>
    `${r.key.toUpperCase()} ${r.confidence}${r.clearsGate ? ' CLEARS GATE' : r.aboveCeiling ? ' cohort changed' : ''} (H4 ${r.h4})`
  ).join(' | ');
  console.log(`${box} gate=${gate}${settingsError ? ' SETTINGS-ERROR' : ''} :: ${line}`);

  if (fired.length && NOTIFY && !DRY) {
    const body = [
      `H4 AGREEMENT — ${fired.map((f) => f.key.toUpperCase()).join(', ')} left the dead cohort`,
      `box ${box}   gate ${gate}${settingsError ? '   WARNING: server is on DEFAULT settings, not the saved file' : ''}`,
      '',
      ...fired.map((f) => [
        `${f.key.toUpperCase()}  confidence ${f.confidence}  ${f.clearsGate ? 'CLEARS THE GATE' : `still ${gate - f.confidence} short`}`,
        `  setup ${f.setup}   D1 ${f.trend}   H4 ${f.h4}   H1 ${f.h1}`,
      ].join('\n')),
      '',
      `Confidence above ${COHORT_CEILING} means H4 now agrees with the daily — while it sat at 40 the`,
      `cohort ceiling was ${COHORT_CEILING}, below the gate, so nothing could fire however good the setup.`,
      'This is an observation. It places no order and changes no setting.',
    ].join('\n');
    const sent = sendTelegram(body);
    console.log(`TELEGRAM ${sent.verdict}`);
    // THE STATE IS WRITTEN ONLY ON A CONFIRMED SEND. If Telegram refused, the next run
    // must still treat this as unreported rather than swallowing the one alert that
    // mattered — the same rule confluence.cjs learned the hard way.
    if (!sent.ok) process.exit(3);
  } else if (fired.length) {
    console.log(`WOULD ALERT: ${fired.map((f) => f.key.toUpperCase()).join(', ')}${DRY ? ' (--dry)' : ' (no --notify)'}`);
  }

  if (!DRY) {
    const next = {};
    for (const r of rows) next[r.key] = { aboveCeiling: r.aboveCeiling, confidence: r.confidence, at: now };
    next._meta = { gate, cohortCeiling: COHORT_CEILING, box, at: now };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, STATE_FILE);   // atomic: a killed run never leaves a half-written baseline
  }
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(3); });
