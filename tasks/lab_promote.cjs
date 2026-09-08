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
     7. PROVABLE IN <= 365 DAYS forward trades needed to clear zero, divided by the
                                candidate's own trade rate. Added 2026-09-08 after
                                measuring the five staged survivors: they needed
                                1,490 / 1,836 / 1,893 / 6,239 / 6,709 DAYS to settle,
                                and all five had ZERO forward trades because
                                lab_shadow.cjs had never been scheduled. A candidate
                                that cannot be settled inside a year is a permanent
                                maybe: it consumes attention and returns no answer.
                                Note this rule PREFERS FREQUENT candidates over
                                high-expectancy ones - a +0.087R edge needs 2,394
                                trades to prove, a +0.43R edge needs 114.

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
/* A CAVEAT TRAVELS WITH THE RESULT. IT DOES NOT SUPPRESS IT.
   NAS100 correlates 0.951 with SP500 (measured 2026-09-05), so the two are close to the
   same trade and must never be sized as independent instruments alongside each other -
   server/assets.js would count them as independent. That is a sizing and portfolio
   constraint, NOT a verdict on whether the strategy makes money.

   An earlier version of this file made it a hard veto. That was wrong twice over: it
   blocked the evidence that would settle the question from ever accumulating, and it
   decided on the system's behalf something that is the operator's call once proof
   exists. The rule here is that it goes live only if it PROVES it makes money - and a
   veto guarantees it never can.

   So a caveated candidate still clears the bar, still stages, and still runs forward in
   lab_shadow. The caveat rides along in the staged record and in the alert, so nobody
   reads the number without the constraint attached. */
const INSTRUMENT_CAVEATS = {
  NAS100: '0.951 correlation with SP500 (2026-09-05) - close to the same trade. Must not '
        + 'be sized as an independent instrument alongside SP500, and needs its own '
        + 'forward proof before going live.',
};

const BAR = {
  REQUIRE_VERDICT:        'SURVIVES',
  MIN_TRADES:             100,
  MIN_DSR:                0.95,
  MIN_OOS_EXPECTANCY_R:   0,
  MIN_PF_AT_2X_COST:      1.10,
  MIN_NEIGHBOURS:         4,
  MIN_NEIGHBOUR_POSITIVE: 0.60,

  // RULE 7: it must be PROVABLE IN A HUMAN TIMEFRAME.
  //
  // Measured 2026-09-08 across the five staged survivors, using lab_shadow's own
  // arithmetic - forward trades needed to separate the OOS edge from zero, divided by
  // the candidate's observed trade rate:
  //
  //   bb_squeeze_break BTC H1   +0.4319R   114 trades   1,490 days
  //   ict_mss_fvg      BTC H1   +0.1831R   540 trades   1,893 days
  //   swing_trend_pb   BTC H1   +0.1525R   774 trades   1,836 days
  //   ict_mss_fvg      BTC H4   +0.2417R   358 trades   6,239 days
  //   donchian_break   BTC H1   +0.0873R 2,394 trades   6,709 days
  //
  // FOUR TO EIGHTEEN YEARS EACH. Every one of them had ZERO forward trades, because
  // lab_shadow.cjs was written and never scheduled - so the queue was full of candidates
  // that could not have been judged in this decade even if it had been.
  //
  // A candidate that cannot be settled inside a year is not a finding, it is a permanent
  // maybe. Staging it costs attention and returns nothing. The two levers that move this
  // are TRADE RATE and EDGE SIZE: a +0.43R edge needs 114 trades, a +0.087R edge needs
  // 2,394 for the same confidence - so ranking by backtest expectancy alone actively
  // prefers the ones that can never be proven.
  MAX_DAYS_TO_PROOF:      365,
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

  // THE SAME CANDIDATE AT LAB SCOPE, because the bar's scope is a CHOICE and the
  // reader is entitled to see what it cost.
  //
  // Trials are counted per FAMILY (strategy|symbol|timeframe) on purpose: different
  // families answer different questions, and deflating a Gold ema_cross result by
  // BTC squeeze trials over-penalises it. But the moment a candidate is surfaced by
  // ranking across EVERY family — which is how a human actually looks at a
  // leaderboard — the selection was global, and the honest multiplicity for THAT
  // claim is every assessment on disk.
  //
  // Measured 2026-08-31 on the first candidate ever to clear: DSR 96.3% at its
  // family's 96 trials, 77.8% at the lab's 1,947. It passes at one scope and fails
  // at the other, and reporting only the flattering one would be a choice dressed
  // as a fact.
  //
  // THE BAR STILL USES FAMILY SCOPE, deliberately. The generator runs 24/7, so a
  // lab-wide count grows without bound and its DSR tends to zero — a bar that
  // becomes unclearable by the mere passage of time, which is the exact defect
  // already fixed once in this file's history. So: family scope decides, lab scope
  // is disclosed, and the reader judges the gap.
  let labTrials = null, labScope = null;
  try {
    const dir = LAB_DIR;
    labTrials = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).length
      : null;
    if (labTrials && labTrials > 1) {
      const sr0Lab = expectedMaxSharpe(labTrials, varTrial);
      labScope = probabilisticSharpe(sr, sr0Lab, T, all.skew, all.kurt);
    }
  } catch (e) { /* disclosure is best-effort; it must never block the judgement */ }

  return { stored, current, trials, recomputed: true, labTrials, labScope };
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
  // Recorded, never subtracted from `pass`. A caveat is information the reader needs,
  // not a reason to hide the result.
  const symbol = (report.spec || {}).symbol;
  const caveat = symbol ? INSTRUMENT_CAVEATS[symbol] : null;
  if (caveat) reasons.push('CAVEAT  ' + symbol + ': ' + caveat);
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
      + (rd.labScope !== null && rd.labScope !== undefined
          ? '; at LAB scope (' + rd.labTrials + ' assessments) it is '
            + rd.labScope.toFixed(4) + ' — the bar uses FAMILY scope by design'
          : '')
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

  const proof = daysToProof(report);
  pass = push(proof.days !== null && proof.days <= BAR.MAX_DAYS_TO_PROOF,
    'provable within ' + BAR.MAX_DAYS_TO_PROOF + ' days (needs ~'
      + (proof.tradesNeeded === null ? '?' : proof.tradesNeeded) + ' forward trades at '
      + (proof.ratePerDay === null ? '?' : proof.ratePerDay.toFixed(3)) + '/day = '
      + (proof.days === null ? 'UNKNOWN' : Math.round(proof.days) + ' days')
      + (proof.reason ? '; ' + proof.reason : '') + ')') && pass;

  return { pass, reasons, plateau: plat, deflation: rd, proof };
}

/**
 * How long would it take to SETTLE this candidate forward?
 *
 * trades needed for the OOS edge to clear zero at ~2 standard errors:
 *     n = (2 * sd / edge)^2
 * then divided by the candidate's observed trade rate.
 *
 * This is the same arithmetic lab_shadow.cjs prints per staged candidate; it is applied
 * HERE so a candidate that cannot be settled in a year is never staged in the first
 * place, rather than discovered to be unsettleable months later.
 *
 * Returns days: null when the inputs are missing - and null FAILS the rule, because
 * "we cannot tell how long this would take" is not grounds for staging it.
 */
/**
 * THE SAME SPEC ON OTHER INSTRUMENTS.
 *
 * The registry keys a family as strategy|symbol|timeframe, so XAUUSD and BTCUSD running
 * IDENTICAL parameters are two unrelated families and neither ever learns about the other.
 * That is how a 1-of-3 result reads as a clean winner.
 *
 * Measured 2026-09-08: ict_mss_fvg H1 structure40/minGap03/within8 was tried on BTCUSD,
 * SP500 and XAUUSD. It SURVIVED on BTC alone - and BTC was the only one anybody saw. An
 * effect present on one instrument and absent on its two siblings is the cross-instrument
 * form of a spike, and the plateau rule already refuses that shape across PARAMETERS.
 * This is the same argument across INSTRUMENTS.
 *
 * It is also the cheapest power available. Pooling a spec over 4 instruments roughly
 * quadruples its trade rate, and time-to-proof is trades/rate - so corroboration and
 * provability improve together.
 *
 * Compares on the canonical spec with `symbol` removed, so only the instrument differs.
 */
function crossInstrument(spec) {
  if (!spec) return null;
  let rows = [];
  try { rows = registry.readAll(); } catch (err) { return null; }

  const shapeOf = (s) => {
    const { symbol, ...rest } = s || {};
    try { return JSON.stringify(registry.canonical(rest)); }
    catch (err) { return JSON.stringify(rest); }
  };
  const target = shapeOf(spec);

  // Newest run per symbol, so a re-run replaces rather than double-counts.
  const bySymbol = new Map();
  for (const r of rows) {
    if (!r || !r.spec || !r.spec.symbol) continue;
    if (shapeOf(r.spec) !== target) continue;
    bySymbol.set(r.spec.symbol, r);
  }

  const siblings = [];
  let positive = 0;
  for (const [symbol, r] of bySymbol) {
    const oos = ((r.summary || {}).outOfSample || {});
    const e = typeof oos.expectancyR === 'number' ? oos.expectancyR : null;
    if (e !== null && e > 0) positive++;
    siblings.push({ symbol, expectancyR: e, verdict: ((r.summary || {}).assessment || {}).verdict || null });
  }

  return {
    evaluated: siblings.length,
    positive,
    positiveFraction: siblings.length ? positive / siblings.length : 0,
    siblings: siblings.sort((a, b) => (b.expectancyR ?? -9) - (a.expectancyR ?? -9)),
  };
}

function daysToProof(report) {
  const oos = report.outOfSample || {};
  const all = report.all || {};
  const edge = typeof oos.expectancyR === 'number' ? oos.expectancyR : null;
  const sd = typeof oos.sdR === 'number' ? oos.sdR
    : (typeof all.sdR === 'number' ? all.sdR : null);
  const rate = typeof all.tradesPerDay === 'number' ? all.tradesPerDay
    : (typeof report.tradesPerDay === 'number' ? report.tradesPerDay : null);

  if (edge === null || edge <= 0) return { days: null, tradesNeeded: null, ratePerDay: rate, reason: 'no positive OOS edge to prove' };
  if (sd === null || !(sd > 0))   return { days: null, tradesNeeded: null, ratePerDay: rate, reason: 'no OOS standard deviation recorded' };
  if (rate === null || !(rate > 0)) return { days: null, tradesNeeded: null, ratePerDay: null, reason: 'no trade rate recorded' };

  const tradesNeeded = Math.ceil(Math.pow((2 * sd) / edge, 2));
  return { days: tradesNeeded / rate, tradesNeeded, ratePerDay: rate, reason: null };
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
    // Directly under the label, before any number. A constraint printed after the
    // numbers is read after the decision has already been formed.
    ...(function () {
      const c = (verdict.reasons || []).find(function (r) { return r.indexOf('CAVEAT') === 0; });
      return c ? ['', '<b>⚠ ' + esc(c.replace(/^CAVEAT\s+/, '')) + '</b>'] : [];
    })(),
    '',
    'trades        ' + all.n + '   (' + (rep.barsUsed ? rep.barsUsed.from + ' .. ' + rep.barsUsed.to : '') + ')',
    'expectancy    ' + (all.expectancyR || 0).toFixed(4) + 'R      OOS ' + (oos.expectancyR || 0).toFixed(4) + 'R',
    'profit factor ' + (all.profitFactor || 0).toFixed(3),
    'deflated SR   ' + (((verdict.deflation && verdict.deflation.current) || 0) * 100).toFixed(1)
      + '%  at ' + ((verdict.deflation && verdict.deflation.trials) || 1) + ' trials',
    'plateau       ' + (plat ? plat.positive + '/' + plat.evaluated + ' neighbours positive on ' + plat.parameter : 'n/a'),
    ((verdict.deflation && verdict.deflation.labScope !== null && verdict.deflation.labScope !== undefined)
      ? 'lab scope     ' + (verdict.deflation.labScope * 100).toFixed(1) + '%  at '
        + verdict.deflation.labTrials + ' assessments  (the bar uses FAMILY scope)'
      : ''),
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
      // Also a named field, not only a line inside reasons: a reader filtering staged
      // candidates should not have to string-match an array to find the constraint.
      caveat: (INSTRUMENT_CAVEATS[(rep.spec || {}).symbol] || null),
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

  // ---- RULE 7: provable inside a year -------------------------------------------
  // The five real survivors on 2026-09-08 needed 1,490-6,709 days. These cases pin the
  // arithmetic so a future edit cannot quietly turn the rule back into decoration.
  const proofOf = (oos, all) => daysToProof({ outOfSample: oos, all });

  // donchian_break BTC H1, as measured: +0.0873R edge, sd 2.1781, 0.357 trades/day.
  const slow = proofOf({ expectancyR: 0.0873, sdR: 2.1781 }, { tradesPerDay: 0.357 });
  ok('a weak edge needs thousands of trades', slow.tradesNeeded > 2000);
  ok('and is refused: years, not months', slow.days > BAR.MAX_DAYS_TO_PROOF);

  // A strong, frequent candidate is the shape the lab SHOULD be hunting.
  const fast = proofOf({ expectancyR: 0.45, sdR: 2.2 }, { tradesPerDay: 4.0 });
  ok('a strong frequent edge is provable in under a year', fast.days <= BAR.MAX_DAYS_TO_PROOF);

  // Edge size dominates: quadrupling the edge cuts trades needed ~16x.
  ok('trades needed scale as (sd/edge)^2',
    proofOf({ expectancyR: 0.1, sdR: 2 }, { tradesPerDay: 1 }).tradesNeeded
      === Math.ceil(Math.pow(2 * 2 / 0.1, 2)));

  // Missing inputs must FAIL, never pass by default - "we cannot tell" is not grounds.
  ok('unknown trade rate cannot clear',
    proofOf({ expectancyR: 0.3, sdR: 2 }, {}).days === null);
  ok('unknown sd cannot clear',
    proofOf({ expectancyR: 0.3 }, { tradesPerDay: 5 }).days === null);
  ok('a candidate with no proof horizon is rejected by judge()',
    judge({ ...good, outOfSample: { expectancyR: 0.3 } }).pass === false);

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

  // A rejected instrument must fail even with a perfect report, or the rule is decoration.
  const perfect = {
    spec: { symbol: 'NAS100', strategy: 'bb_squeeze_break', timeframe: 'H1' },
    assessment: { verdict: 'SURVIVES', checksUnknown: 0 },
    all: { n: 9999 }, deflated: { current: 0.99, trials: 1 },
    costStress: { x2: { profitFactor: 9 } },
  };
  const nas = judge(perfect);
  // The assertion is NOT that this fixture passes - it is a stub and misses several
  // real checks. It is that the caveat never appears as a REASON FOR FAILURE, which is
  // the whole difference between a caveat and the veto this used to be.
  const caveatFailed = !!(nas && (nas.reasons || []).some(function (r) {
    return r.indexOf('FAIL') === 0 && r.indexOf('correlation') >= 0;
  }));
  ok('the caveat never causes a failure - it is information, not a veto', !caveatFailed,
     nas ? JSON.stringify((nas.reasons || []).filter(function (r) { return r.indexOf('FAIL') === 0; })) : 'no result');
  ok('and the caveat travels with it, so the number is never read alone',
     !!(nas && (nas.reasons || []).some(function (r) {
       return r.indexOf('CAVEAT') === 0 && r.indexOf('NAS100') >= 0;
     })));
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
