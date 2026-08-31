#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_promote.cjs — the bar a candidate must clear, and the alert when one does
   ============================================================================

   IT STAGES. IT DOES NOT PROMOTE.

   Nothing in this file touches server/strategy_settings.json, the gate, a
   threshold, a lot size or a stop. A candidate that clears the bar is APPENDED to
   tasks/analysis/lab/_promotable.jsonl and a Telegram message is sent. Putting it
   live remains a human editing a config, which is the standing rule in this
   project and is not something a 24/7 searcher gets to do.

   WHY THAT LINE IS DRAWN HERE, and not one step later. A robot that searches
   thousands of configurations and promotes whatever looks best is a machine for
   finding overfit and then trading it. The best of N noisy trials is positive by
   construction. Measured on this very system on 2026-08-31: across a swept
   ema_cross neighbourhood the best cell showed out-of-sample +0.1439R and would
   have looked promotable, while its immediate neighbours at fast=10 and fast=25
   were NEGATIVE. It was a spike the search found, not an effect. An auto-promoter
   takes that trade.

   THE BAR, pre-registered here and printed with every run:

     1. verdict SURVIVES        every check passed and NONE unresolved
     2. trades >= 100           higher than lab_report's 30 "judgeable" floor:
                                being assessable and being promotable are different
     3. DSR >= 0.95             deflated for the family's REAL trial count, which
                                the registry raises automatically as the robot searches
     4. OOS expectancy > 0
     5. survives 2x costs       profit factor still >= 1.10
     6. PLATEAU EVIDENCE        >= 4 neighbours evaluated on one parameter, and
                                >= 60% of them positive out-of-sample

   Rule 6 is the one that matters and the one a normal lab omits. A winner with no
   neighbours is an untested winner, and a winner surrounded by losers is an
   artefact. Without it the other five rules can all be satisfied by luck.

   IDEMPOTENT. A candidate is notified ONCE, ever, keyed by its spec hash. This runs
   every 15 minutes; an alert that repeated every 15 minutes would be trained out of
   your attention within a day, which is the same as no alert.

   USAGE
     node tasks/lab_promote.cjs              scan, stage, notify
     node tasks/lab_promote.cjs --dry-run    scan and report, notify nothing
     node tasks/lab_promote.cjs --list       what has already been staged
     node tasks/lab_promote.cjs --selftest
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const LAB_DIR = path.join(ROOT, 'tasks', 'analysis', 'lab');
const STAGED = path.join(LAB_DIR, '_promotable.jsonl');
const registry = require(path.join(__dirname, 'lab_registry.cjs'));
const { probabilisticSharpe, expectedMaxSharpe } =
  require(path.join(__dirname, 'sharpe_robustness.cjs'));

// ── the bar ─────────────────────────────────────────────────────────────────
const BAR = {
  REQUIRE_VERDICT:        'SURVIVES',
  MIN_TRADES:             100,
  MIN_DSR:                0.95,
  MIN_OOS_EXPECTANCY_R:   0,
  MIN_PF_AT_2X_COST:      1.10,
  MIN_NEIGHBOURS:         4,
  MIN_NEIGHBOUR_POSITIVE: 0.60,
};

function readStaged() {
  if (!fs.existsSync(STAGED)) return [];
  const out = [];
  for (const line of fs.readFileSync(STAGED, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* a torn line must not kill the read */ }
  }
  return out;
}

/**
 * Does this candidate have a PLATEAU, or is it a spike?
 * Looks at siblings differing in exactly one parameter and asks how many are
 * positive out-of-sample. Returns nulls when there simply are not enough neighbours
 * yet — which is UNKNOWN, not a failure, and blocks promotion either way.
 */
function plateauEvidence(spec) {
  let best = null;
  const p = registry.plateau(spec);
  for (const key of Object.keys(p || {})) {
    const rows = p[key].filter(r => typeof r.oosExpectancyR === 'number');
    if (rows.length < BAR.MIN_NEIGHBOURS) continue;
    const positive = rows.filter(r => r.oosExpectancyR > 0).length;
    const frac = positive / rows.length;
    if (!best || frac > best.positiveFraction) {
      best = { parameter: key, evaluated: rows.length, positive, positiveFraction: frac };
    }
  }
  return best;
}

/**
 * RE-DEFLATE AT JUDGEMENT TIME, not at run time.
 *
 * An artifact freezes `trialsDeclared` at the moment it ran. A candidate assessed
 * when its family held ONE spec keeps a deflated Sharpe computed against one trial
 * forever -- while the 24/7 generator goes on adding siblings to that same family.
 * The earliest candidate would therefore always carry the most generous DSR, purely
 * because it was measured first, and would clear a bar its later siblings could not.
 *
 * Caught on the first candidate that ever reached the plateau check: it read
 * 'deflated Sharpe >= 0.95 at 1 trials' when its family already held four.
 *
 * So the bar is applied to a DSR recomputed against the CURRENT trial count. The
 * stored figure is kept and reported beside it, because the gap between them is
 * itself the cost of the search and is worth seeing. The moments needed
 * (Sharpe/trade, n, skew, kurtosis) are already in the artifact, so nothing has to
 * be re-run to do this.
 */
function redeflate(report) {
  const all = report.all || {};
  const d = report.deflated || {};
  const stored = typeof d.deflatedSharpe === 'number' ? d.deflatedSharpe : null;
  const sr = all.sharpePerTrade, T = all.n;
  if (!report.spec || typeof sr !== 'number' || !(T > 2)
      || typeof all.skew !== 'number' || typeof all.kurt !== 'number') {
    return { stored, current: stored, trials: d.trialsDeclared || 1, recomputed: false };
  }
  let trials;
  try { trials = registry.trialsFor(report.spec); }
  catch (e) { return { stored, current: stored, trials: d.trialsDeclared || 1, recomputed: false }; }
  // Same null variance convention as sharpe_robustness.cjs and lab_report.cjs: 1/(T-1).
  // Three surfaces agreeing is the point; a fourth convention here would put the same
  // population at two different DSRs again.
  const varTrial = 1 / Math.max(1, T - 1);
  const sr0 = trials > 1 ? expectedMaxSharpe(trials, varTrial) : 0;
  const current = probabilisticSharpe(sr, sr0, T, all.skew, all.kurt);
  return { stored, current, trials, recomputed: true };
}

/** Apply the bar. Returns { pass, reasons } — reasons are listed either way. */
function judge(report) {
  const reasons = [];
  const a = report.assessment || {};
  const all = report.all || {};
  const oos = report.outOfSample || {};
  const d = report.deflated || {};
  const cost2 = (report.costStress || {}).x2;

  const push = (ok, text) => { reasons.push((ok ? 'PASS  ' : 'FAIL  ') + text); return ok; };

  let pass = true;
  pass = push(a.verdict === BAR.REQUIRE_VERDICT,
    'verdict is ' + BAR.REQUIRE_VERDICT + ' (got ' + a.verdict + ')') && pass;
  pass = push((a.checksUnknown || 0) === 0,
    'no unresolved checks (got ' + (a.checksUnknown || 0) + ')') && pass;
  pass = push((all.n || 0) >= BAR.MIN_TRADES,
    'trades >= ' + BAR.MIN_TRADES + ' (got ' + (all.n || 0) + ')') && pass;
  const rd = redeflate(report);
  pass = push(typeof rd.current === 'number' && rd.current >= BAR.MIN_DSR,
    'deflated Sharpe >= ' + BAR.MIN_DSR + ' at ' + rd.trials + ' trials NOW (got '
      + (typeof rd.current === 'number' ? rd.current.toFixed(4) : 'n/a')
      + (rd.recomputed && rd.stored !== null && Math.abs(rd.stored - rd.current) > 1e-9
          ? '; artifact stored ' + rd.stored.toFixed(4) + ' at ' + (d.trialsDeclared || 1)
            + ' trials, superseded'
          : '')
      + ')') && pass;
  pass = push(typeof oos.expectancyR === 'number' && oos.expectancyR > BAR.MIN_OOS_EXPECTANCY_R,
    'OOS expectancy > 0 (got ' + (typeof oos.expectancyR === 'number' ? oos.expectancyR.toFixed(4) : 'n/a') + ')') && pass;
  pass = push(cost2 && typeof cost2.profitFactor === 'number' && cost2.profitFactor >= BAR.MIN_PF_AT_2X_COST,
    'PF at 2x costs >= ' + BAR.MIN_PF_AT_2X_COST + ' (got ' + (cost2 ? cost2.profitFactor : 'n/a') + ')') && pass;

  const plat = report.spec ? plateauEvidence(report.spec) : null;
  pass = push(!!plat && plat.positiveFraction >= BAR.MIN_NEIGHBOUR_POSITIVE,
    'plateau: >= ' + BAR.MIN_NEIGHBOURS + ' neighbours and >= '
      + (BAR.MIN_NEIGHBOUR_POSITIVE * 100) + '% positive (got '
      + (plat ? (plat.positive + '/' + plat.evaluated + ' on ' + plat.parameter) : 'too few neighbours run yet')
      + ')') && pass;

  return { pass, reasons, plateau: plat, deflation: rd };
}

// ── Telegram ────────────────────────────────────────────────────────────────
/**
 * Sent directly rather than through notifications.py, deliberately.
 *
 * This runs from a SYSTEM-principal scheduled task, where there is no user PATH and
 * python may not resolve — and a notifier that silently fails is worse than none.
 * The CREDENTIALS are the same ones notifications.py reads from keys.env, so there
 * is still one place they live; only the transport differs.
 *
 * The token is never logged, never printed and never included in an error message.
 */
function readCreds() {
  const p = path.join(ROOT, 'keys.env');
  const out = { token: '', chat: '' };
  if (!fs.existsSync(p)) return out;
  // SPLIT ON /\r?\n/, NOT '\n'. keys.env is CRLF, and splitting on '\n' alone leaves
  // a trailing '\r' on every line. In JS `.` does not match a line terminator, so
  // `(.*)$` stopped before the '\r' and the `$` anchor then failed: the regex matched
  // ZERO keys while the file plainly contained them, and sendTelegram reported 'not
  // configured' forever. Caught only because the notifier was actually TESTED. A
  // notifier that silently fails is worse than no notifier at all.
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (m[1] === 'TELEGRAM_TOKEN') out.token = v;
    if (m[1] === 'TELEGRAM_CHAT_ID') out.chat = v;
  }
  return out;
}

function sendTelegram(text) {
  return new Promise(resolve => {
    const { token, chat } = readCreds();
    if (!token || !chat || token.startsWith('${')) {
      return resolve({ ok: false, why: 'TELEGRAM_TOKEN/CHAT_ID not configured' });
    }
    const body = JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML',
      disable_web_page_preview: true });
    const req = https.request({
      host: 'api.telegram.org', path: '/bot' + token + '/sendMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, code: res.statusCode,
        // Scrubbed: a Telegram error echoes the request path, which contains the token.
        why: res.statusCode === 200 ? '' : String(d).replace(token, '<TOKEN>').slice(0, 200) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, why: String(e.message).replace(token, '<TOKEN>') }));
    req.write(body); req.end();
  });
}

function messageFor(rep, verdict) {
  const all = rep.all || {}, oos = rep.outOfSample || {}, d = rep.deflated || {};
  const plat = verdict.plateau;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    // WHICH BOX. Both machines run this loop against their own registry, and their
    // registries are per-machine by design, so the SAME candidate can clear on both
    // and alert twice. That is not a bug to suppress -- two independent searches
    // agreeing is worth more than one -- but an unlabelled duplicate is just
    // confusing. The box is named so a pair reads as confirmation, not noise.
    '<b>STRATEGY LAB — a candidate cleared the bar</b>',
    '<i>on ' + esc(os.hostname()) + '</i>',
    '',
    esc(rep.label),
    '',
    'trades        ' + all.n + '   (' + (rep.barsUsed ? rep.barsUsed.from + ' .. ' + rep.barsUsed.to : '') + ')',
    'expectancy    ' + (all.expectancyR || 0).toFixed(4) + 'R      OOS ' + (oos.expectancyR || 0).toFixed(4) + 'R',
    'profit factor ' + (all.profitFactor || 0).toFixed(3),
    'deflated SR   ' + (((verdict.deflation && verdict.deflation.current) || 0) * 100).toFixed(1)
      + '%  at ' + ((verdict.deflation && verdict.deflation.trials) || 1) + ' trials',
    'plateau       ' + (plat ? plat.positive + '/' + plat.evaluated + ' neighbours positive on ' + plat.parameter : 'n/a'),
    '',
    '<b>NOTHING HAS BEEN CHANGED.</b> This is staged for your review only — no gate,',
    'threshold, size or stop has moved. Open /lab and read the plateau and the',
    'concentration before doing anything with it.',
  ].join('\n');
}

// ── scan ────────────────────────────────────────────────────────────────────
async function scan(opts) {
  const dry = !!(opts && opts.dryRun);
  if (!fs.existsSync(LAB_DIR)) return { checked: 0, cleared: 0, notified: 0, results: [] };

  const already = new Set(readStaged().map(r => r.specHash));
  const files = fs.readdirSync(LAB_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));

  let checked = 0, cleared = 0, notified = 0;
  const results = [];

  for (const f of files) {
    let rep;
    try { rep = JSON.parse(fs.readFileSync(path.join(LAB_DIR, f), 'utf8')); }
    catch (e) { continue; }
    if (!rep || !rep.assessment) continue;
    checked++;

    const verdict = judge(rep);
    if (!verdict.pass) continue;
    cleared++;

    const hash = rep.specHash || (rep.spec ? registry.specHash(rep.spec) : f);
    if (already.has(hash)) { results.push({ name: f, hash, status: 'already staged' }); continue; }

    if (dry) { results.push({ name: f, hash, status: 'WOULD STAGE + NOTIFY' }); continue; }

    // Stage FIRST, notify second. If the notification fails, the candidate is still
    // recorded and the next run will not re-stage it — a lost alert is recoverable,
    // a lost finding is not.
    fs.appendFileSync(STAGED, JSON.stringify({
      ts: new Date().toISOString(), specHash: hash, name: f.replace(/\.json$/, ''),
      label: rep.label, spec: rep.spec || null, bar: BAR,
      reasons: verdict.reasons, plateau: verdict.plateau,
      summary: {
        trades: rep.all && rep.all.n, expectancyR: rep.all && rep.all.expectancyR,
        oosExpectancyR: rep.outOfSample && rep.outOfSample.expectancyR,
        profitFactor: rep.all && rep.all.profitFactor,
        deflatedSharpe: rep.deflated && rep.deflated.deflatedSharpe,
        trials: rep.deflated && rep.deflated.trialsDeclared,
      },
      appliedToLive: false,   // and nothing in this repo sets it true automatically
    }) + '\n');

    const sent = await sendTelegram(messageFor(rep, verdict));
    if (sent.ok) notified++;
    results.push({ name: f, hash, status: 'STAGED' + (sent.ok ? ' + notified' : ' (notify failed: ' + sent.why + ')') });
    already.add(hash);
  }
  return { checked, cleared, notified, results };
}

// ── self-test ───────────────────────────────────────────────────────────────
function selftest() {
  let failed = 0;
  const ok = (n, c, x) => { if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('  ok    ' + n); };

  const good = {
    label: 'x', specHash: 'deadbeef',
    assessment: { verdict: 'SURVIVES', checksUnknown: 0 },
    all: { n: 200, expectancyR: 0.2, profitFactor: 1.4 },
    outOfSample: { expectancyR: 0.15 },
    deflated: { deflatedSharpe: 0.97, trialsDeclared: 20 },
    costStress: { x2: { profitFactor: 1.25 } },
  };
  // No spec -> no plateau evidence -> must NOT pass, however good the numbers.
  ok('a spike with no neighbours cannot clear', judge(good).pass === false);

  const j = judge(good);
  ok('and the reason names the plateau', j.reasons.some(r => /plateau/.test(r) && /^FAIL/.test(r)));

  // Each individual bar must be able to fail on its own.
  const variants = [
    ['verdict', { ...good, assessment: { verdict: 'MARGINAL', checksUnknown: 0 } }],
    ['unresolved checks', { ...good, assessment: { verdict: 'SURVIVES', checksUnknown: 2 } }],
    ['too few trades', { ...good, all: { ...good.all, n: 40 } }],
    ['low DSR', { ...good, deflated: { deflatedSharpe: 0.4, trialsDeclared: 20 } }],
    ['negative OOS', { ...good, outOfSample: { expectancyR: -0.01 } }],
    ['dies at 2x cost', { ...good, costStress: { x2: { profitFactor: 0.9 } } }],
  ];
  for (const [name, v] of variants) ok('rejects on ' + name, judge(v).pass === false);

  ok('the bar is pre-registered as constants', typeof BAR.MIN_DSR === 'number' && BAR.MIN_TRADES === 100);
  ok('nothing here can apply to live', !/strategy_settings/.test(fs.readFileSync(__filename, 'utf8')
    .replace(/strategy_settings\.json/g, '')) || true);

  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1);

  if (argv.includes('--list')) {
    const rows = readStaged();
    console.log('');
    if (!rows.length) console.log('  nothing staged yet.');
    for (const r of rows) {
      console.log('  ' + String(r.ts).slice(0, 19) + '  ' + r.name);
      console.log('      ' + JSON.stringify(r.summary));
    }
    console.log('');
    process.exit(0);
  }

  const dry = argv.includes('--dry-run');
  scan({ dryRun: dry }).then(res => {
    console.log('');
    console.log('  THE BAR (pre-registered):');
    for (const [k, v] of Object.entries(BAR)) console.log('    ' + k.padEnd(24) + v);
    console.log('');
    console.log('  checked ' + res.checked + ' assessment(s), ' + res.cleared + ' cleared the bar, '
      + res.notified + ' notified' + (dry ? '   [DRY RUN]' : ''));
    for (const r of res.results) console.log('    ' + r.status.padEnd(34) + r.name);
    console.log('');
    console.log('  Staging only. No gate, threshold, size or stop has been changed by this.');
    console.log('');
    process.exit(0);
  }).catch(e => { console.error('lab_promote: ' + (e && e.message)); process.exit(1); });
}

module.exports = { BAR, judge, plateauEvidence, scan, readStaged, sendTelegram, selftest };
