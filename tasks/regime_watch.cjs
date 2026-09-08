#!/usr/bin/env node
'use strict';
/**
 * IS THE EDGE STILL THERE, OR DID IT LIVE IN ONE WINDOW?
 *
 * WHY THIS EXISTS. Measured 2026-09-08: EA_CRT_AMD on gold showed +0.188R/trade over its
 * most recent 110 trades and was configured on that basis - trail off, partial TP on,
 * gold only. Over the full 1,583 trades it is -0.0055R, PF 0.99, 30.3% max drawdown. The
 * whole apparent edge lived in ONE four-month window; the 1,473 trades before it were
 * flat-to-losing.
 *
 * Nothing watched for that. Every surface reported the recent number, and the recent
 * number is exactly the one that flatters a strategy whose edge has already gone.
 *
 * THIS COMPARES RECENT AGAINST LIFETIME, per model, and says when they disagree.
 *
 * ── IT REFUSES TO CONCLUDE FROM A SMALL SAMPLE, AND SAYS SO ─────────────────────
 *
 * Measured on this box: tasks/all_trades_ledger.jsonl holds 12,537 rows, of which only
 * 55 are attributable to one of OUR models - the rest are foreign EAs sharing the
 * account. 55 trades across 8 months cannot support a regime verdict, and a tool that
 * pretends otherwise is worse than no tool. Every line therefore carries its n, and any
 * split below MIN_N reports INSUFFICIENT rather than a direction.
 *
 * It reports in MONEY, not R. The ledger carries netProfit and no R value, and inventing
 * one by dividing by an assumed risk would be a number with no measurement behind it -
 * the exact error that made a 4-tuple read as 3 elsewhere today.
 *
 * READ-ONLY. Reads the ledger, prints. Places nothing, changes no config.
 *
 *   node tasks/regime_watch.cjs                 recent 30 days vs lifetime
 *   node tasks/regime_watch.cjs --recent 60
 */

const fs = require('fs');
const path = require('path');

// ── ASCII OUT, ALWAYS ─────────────────────────────────────────────────────────
// The scheduled task redirects stdout to a file through cmd.exe, and cmd applies the
// CONSOLE CODEPAGE. Measured 2026-09-08: identical output, same script, both boxes -
// the laptop wrote correct UTF-8 while the VPS report read "STALENESS WATCH <?" age",
// because that box's console codepage is not 65001. A report a human is meant to read
// must not depend on which machine ran it, so the typographic characters are folded to
// ASCII at the output boundary rather than being banned from the source.
const ASCII_FOLD = new Map(Object.entries({
  '\u2014': '--', '\u2013': '-', '\u2500': '-', '\u2502': '|', '\u2508': '-',
  '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"',
  '\u2026': '...', '\u2265': '>=', '\u2264': '<=', '\u2192': '->', '\u00b7': '-',
  '\u2713': 'ok', '\u2717': 'x', '\u26a0': '!', '\u00a0': ' ',
}));
function toAscii(s) {
  return String(s).replace(/[^\x00-\x7F]/g, (ch) => ASCII_FOLD.get(ch) || '?');
}
const _rawLog = console.log.bind(console);
const _rawErr = console.error.bind(console);
console.log = (...a) => _rawLog(toAscii(a.join(' ')));
console.error = (...a) => _rawErr(toAscii(a.join(' ')));


const ROOT = path.join(__dirname, '..');
const LEDGER = path.join(ROOT, 'tasks', 'all_trades_ledger.jsonl');

function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }
const RECENT_DAYS = numArg('--recent', 30);

// Below this, a split is reported as INSUFFICIENT and no direction is claimed. 20 is not
// a statistical threshold, it is a floor beneath which the arithmetic is theatre.
const MIN_N = 20;

function load() {
  if (!fs.existsSync(LEDGER)) return null;
  const rows = [];
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      // OURS ONLY. `foreign` rows are third-party EAs on the same account: they are the
      // account's exposure but they are not this system's evidence, and pooling them
      // would attribute someone else's results to our models.
      if (!r || r.owner === 'foreign' || !r.model) continue;
      if (typeof r.netProfit !== 'number' || !r.closeTime) continue;
      rows.push(r);
    } catch (e) { /* torn line from a crash mid-write; skip, never rewrite the file */ }
  }
  return rows;
}

function stats(rows) {
  if (!rows.length) return null;
  const net = rows.reduce((s, r) => s + r.netProfit, 0);
  const wins = rows.filter(r => r.netProfit > 0).length;
  const gp = rows.filter(r => r.netProfit > 0).reduce((s, r) => s + r.netProfit, 0);
  const gl = Math.abs(rows.filter(r => r.netProfit < 0).reduce((s, r) => s + r.netProfit, 0));
  return {
    n: rows.length, net, perTrade: net / rows.length,
    winPct: wins / rows.length * 100,
    pf: gl > 0 ? gp / gl : null,
  };
}

function main() {
  const rows = load();
  if (rows === null) { console.error('no ' + LEDGER); process.exitCode = 1; return; }

  console.log('='.repeat(100));
  console.log('  REGIME WATCH — is the edge still there, or did it live in one window?');
  console.log('  ' + new Date().toISOString() + '   recent = last ' + RECENT_DAYS + ' days');
  console.log('  EA_CRT_AMD showed +0.188R over 110 trades and -0.0055R over 1,583. This is that check.');
  console.log('='.repeat(100));

  if (!rows.length) {
    console.log('  No rows attributable to one of our models.');
    console.log('  The ledger is a TWO-ACCOUNT union and most rows are owner=foreign - third-party');
    console.log('  EAs on the same account. That is not a fault; it is what the ledger is.');
    return;
  }

  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  const byModel = new Map();
  for (const r of rows) {
    const k = r.model + ' / ' + (r.symbol || '?');
    if (!byModel.has(k)) byModel.set(k, []);
    byModel.get(k).push(r);
  }

  console.log('');
  console.log('  ' + 'model / symbol'.padEnd(34) + 'window'.padEnd(10) + 'n'.padEnd(6) +
              'net'.padEnd(12) + 'per trade'.padEnd(12) + 'win%'.padEnd(8) + 'PF');

  let flagged = 0;
  for (const [k, all] of [...byModel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const recent = all.filter(r => Date.parse(r.closeTime) >= cutoff);
    const life = stats(all), rec = stats(recent);
    const line = (label, s) => s
      ? '  ' + k.padEnd(34) + label.padEnd(10) + String(s.n).padEnd(6) +
        (s.net >= 0 ? '+' : '') + s.net.toFixed(2).padEnd(11) +
        ((s.perTrade >= 0 ? '+' : '') + s.perTrade.toFixed(3)).padEnd(12) +
        s.winPct.toFixed(1).padEnd(8) + (s.pf === null ? '—' : s.pf.toFixed(2))
      : '  ' + k.padEnd(34) + label.padEnd(10) + '0';
    console.log(line('lifetime', life));
    console.log(line('recent', rec));

    if (!life || life.n < MIN_N) {
      console.log('       INSUFFICIENT — ' + (life ? life.n : 0) + ' trades. No direction claimed at this sample.');
    } else if (rec && rec.n >= MIN_N && life.perTrade > 0 && rec.perTrade < 0) {
      console.log('       ** REGIME FLAG ** lifetime positive, recent NEGATIVE over ' + rec.n + ' trades.');
      flagged++;
    } else if (rec && rec.n < MIN_N) {
      console.log('       recent window too small (' + rec.n + ') to compare — lifetime shown for context only.');
    }
    console.log('');
  }

  console.log('  ' + byModel.size + ' model/symbol pair(s), ' + rows.length + ' attributable trade(s), ' +
              flagged + ' regime flag(s)');
  console.log('  Money, not R: the ledger carries netProfit and no R value, and inventing one from an');
  console.log('  assumed risk would be a number with no measurement behind it.');
}

try { main(); } catch (err) {
  console.error('regime_watch failed: ' + (err && err.message));
  process.exitCode = 1;
}
