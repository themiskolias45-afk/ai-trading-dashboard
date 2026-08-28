#!/usr/bin/env node
'use strict';
/**
 * Find every place that states a live setting as a NUMBER and is now wrong.
 *
 * WHY THIS EXISTS. On 2026-08-27 the same failure was found FIVE separate times in one
 * session, each in a different file, each invisible until something else went looking:
 *
 *   CLAUDE.md            asserted AMD was "unmeasurable until the bridge sends bar
 *                        timestamps" - the bridge had been sending them for weeks.
 *   CLAUDE.md            still asked for a CRT cost walk-forward that RAN on 2026-08-09.
 *   server/index.js      the Telegram alert required strength === "STRONG" while every
 *                        trade ever taken is MODERATE and minStrength IS "MODERATE" - so
 *                        it had never fired once and structurally could not.
 *   rsi_ceiling_wf.cjs   hardcoded 72/68 as "BASELINE - what ships today" after the
 *                        ceiling moved to 80/76, so every verdict it printed was measured
 *                        against a retired setting.
 *   (historically)       FIVE copies of the confidence gate, per CLAUDE.md's own warning.
 *
 * The pattern is always the same: a number is copied out of the config into a doc, a
 * comment or a condition, the config moves, and the copy stays. Nothing detects it,
 * because nothing is broken - the copy is syntactically fine and merely lying.
 *
 * This reads the LIVE settings and then searches the repo for statements about them that
 * disagree. It is deliberately about CLAIMS, not about every integer in the codebase:
 * grepping for the literal 70 would return thousands of lines and be ignored within a
 * week, which is how a check dies.
 *
 * IT CHANGES NOTHING. Read-only: no file is written except the report under --emit, and
 * no setting, threshold, signal or trade is touched. It reports and exits 0; use
 * --strict to exit 1 when drift is found, for a scheduled job that should go red.
 *
 * Usage:
 *   node tasks/config_drift.cjs [--emit] [--strict]
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const EMIT   = process.argv.includes("--emit");
const STRICT = process.argv.includes("--strict");

/**
 * Files worth checking. Deliberately NOT the whole repo: backups, node_modules and the
 * logs directory are full of historical copies that are SUPPOSED to be stale, and
 * flagging them would bury the two lines that matter.
 */
const SEARCH_FILES = [
  "CLAUDE.md",
  "server/index.js",
  "server/evidence_register.js",
  "mt5_bridge.py",
  "tasks/rsi_ceiling_walkforward.cjs",
  "tasks/mtf_walkforward.cjs",
  "tasks/go_live_readiness.cjs",
  "tasks/ai_brief.cjs",
  "tasks/doctor.cjs",
];

/**
 * ...plus every SKILL and AGENT, expanded at run time rather than listed by hand.
 *
 * The list above is exactly the kind of allowlist this tool exists to protect against: a
 * hand-maintained set that only covers what someone remembered. It did not include
 * .claude/, and on 2026-08-28 that was found to matter — the VPS copy of
 * .claude/commands/signal.md still read "needs [65-X]pt more to fire", hardcoding a
 * confidence gate of 65 four weeks after it moved to 70. Agents read those files as
 * INSTRUCTIONS, so a stale number there is not a stale comment; it is a stale rule.
 *
 * Expanded by directory scan so a skill added tomorrow is covered without anyone editing
 * this file. That is the whole difference between a check that keeps working and one that
 * quietly stops.
 */
function expandSearch(root) {
  const out = [...SEARCH_FILES];
  for (const dir of [".claude/commands", ".claude/agents"]) {
    let names;
    try { names = fs.readdirSync(path.join(root, dir)); }
    catch (e) { continue; }                       // absent directory is not an error
    for (const name of names.sort()) {
      if (name.endsWith(".md")) out.push(dir + "/" + name);
    }
  }
  return out;
}

/**
 * Each rule names a live setting and the shapes a CLAIM about it takes in prose or code.
 * `capture` must yield the number being asserted. A rule with no incident behind it is a
 * style preference and does not belong here.
 */
const RULES = [
  {
    setting: "confidenceThreshold",
    label: "confidence gate",
    patterns: [
      /gate\s+(?:is\s+|of\s+)?(\d{2})\b/gi,
      /confidence\s+gate[^.\n]{0,20}?(\d{2})\b/gi,
      /(\d{2})%\s+confidence\s+gate/gi,
      /confidenceThreshold\s*[:=]\s*(\d{2})\b/g,
    ],
    // Historical statements are legitimate when they SAY they are historical.
    exempt: /\b(was|were|used to|until|before|previously|history|superseded|stale|old|no longer|predates|retired)\b/i,
  },
  {
    setting: "momentumRsiMax",
    label: "MOMENTUM RSI ceiling",
    patterns: [
      /ceiling[^.\n]{0,24}?(\d{2})\s*\/\s*\d{2}/gi,
      /momentumRsiMax\s*[:=]\s*(\d{2,3})\b/g,
      /MOMENTUM_RSI_MAX\s*=\s*(\d{2,3})\b/g,
    ],
    exempt: /\b(was|were|used to|until|before|previously|history|superseded|stale|old|no longer|baseline|candidate|default|def:|predates|retired)\b/i,
  },
  {
    setting: "trendFollowRsiMax",
    label: "TREND_FOLLOW RSI ceiling",
    patterns: [
      /ceiling[^.\n]{0,24}?\d{2}\s*\/\s*(\d{2})/gi,
      /trendFollowRsiMax\s*[:=]\s*(\d{2,3})\b/g,
      /TREND_FOLLOW_RSI_MAX\s*=\s*(\d{2,3})\b/g,
    ],
    exempt: /\b(was|were|used to|until|before|previously|history|superseded|stale|old|no longer|baseline|candidate|default|def:|predates|retired)\b/i,
  },
  {
    setting: "fixedLotSize",
    label: "fixed lot size",
    patterns: [/fixedLotSize\s*[:=]\s*([\d.]+)/g, /fixed\s+(?:lot|0\.0\d)\s*(?:size)?[^.\n]{0,12}?([\d.]+)\s*lot/gi],
    exempt: /\b(was|were|used to|until|before|previously|history|superseded|old|no longer|min|max|limit)\b/i,
  },
  {
    setting: "minStrength",
    label: "minimum strength",
    string: true,
    patterns: [/minStrength[^.\n]{0,16}?"(MODERATE|STRONG)"/g, /min\s+strength[^.\n]{0,12}?\b(MODERATE|STRONG)\b/gi],
    exempt: /\b(was|were|used to|until|before|previously|history|superseded|old|no longer|one of|allowed|either)\b/i,
  },
];

function readLiveSettings() {
  const p = path.join(PROJECT_ROOT, "server", "strategy_settings.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
    return { cfg, source: "server/strategy_settings.json" };
  } catch (e) {
    // NEVER fall back to a guessed value here - the whole point is to compare against
    // what is really running. No settings means no verdict.
    return { cfg: null, source: null, error: e.message };
  }
}

function checkFile(rel, cfg, findings) {
  const abs = path.join(PROJECT_ROOT, rel);
  let text;
  try { text = fs.readFileSync(abs, "utf8"); } catch (e) { return { rel, skipped: e.code || "unreadable" }; }
  const lines = text.split(/\r?\n/);

  for (const rule of RULES) {
    const live = cfg[rule.setting];
    if (live === undefined || live === null) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (rule.exempt && rule.exempt.test(line)) continue;
      // A line that READS the setting live is not a claim about its value - it is the
      // correct pattern. `? strategySettings.momentumRsiMax : 72` states the FALLBACK,
      // and `strategySettings.minStrength === "STRONG"` is a comparison, not an
      // assertion that STRONG is the live value. Flagging these was 3 of the first 4
      // hits, i.e. 25% precision, and a check that cries wolf is a check nobody reads -
      // the exact failure this file was written to prevent, committed by this file.
      const readsLive = new RegExp("(?:strategySettings|settings|cfg|config)\\s*\\.\\s*" + rule.setting).test(line);
      if (readsLive) continue;
      for (const re of rule.patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const claimed = m[1];
          if (claimed === undefined) continue;
          const differs = rule.string
            ? String(claimed).toUpperCase() !== String(live).toUpperCase()
            : Number(claimed) !== Number(live);
          if (differs) {
            findings.push({
              file: rel, line: i + 1, setting: rule.setting, label: rule.label,
              claimed, live, text: line.trim().slice(0, 116),
            });
          }
        }
      }
    }
  }
  return { rel, skipped: null };
}

function main() {
  const out = [];
  const say = l => { out.push(l); console.log(l); };

  say("=".repeat(100));
  say(`  CONFIG DRIFT  ${new Date().toISOString()}`);
  say("  Places that state a live setting as a number and are now WRONG.");
  say("=".repeat(100));

  const { cfg, source, error } = readLiveSettings();
  if (!cfg) {
    say(`\n  CANNOT READ THE LIVE SETTINGS (${error}).`);
    say("  No comparison is possible, so no verdict is given - a drift check that guesses");
    say("  the baseline is worse than no drift check.");
    process.exitCode = STRICT ? 1 : 0;
    if (EMIT) write(out);
    return;
  }

  say(`\n  live settings from ${source}:`);
  for (const r of RULES) {
    if (cfg[r.setting] !== undefined) say(`    ${r.setting.padEnd(24)}${cfg[r.setting]}`);
  }

  const findings = [];
  const skipped = [];
  const SEARCH = expandSearch(PROJECT_ROOT);
  for (const rel of SEARCH) {
    const res = checkFile(rel, cfg, findings);
    if (res.skipped) skipped.push(`${rel} (${res.skipped})`);
  }

  say("");
  if (!findings.length) {
    say("  NO DRIFT FOUND across " + (SEARCH.length - skipped.length) + " file(s).");
    say("  That means no CHECKED file states one of these settings as a number that");
    say("  disagrees with what is running. It does not mean every doc is true.");
  } else {
    say(`  ${findings.length} DRIFTED STATEMENT(S):`);
    say("");
    for (const f of findings) {
      say(`  ${f.file}:${f.line}`);
      say(`      ${f.label}: says ${f.claimed}, live is ${f.live}`);
      say(`      | ${f.text}`);
      say("");
    }
    say("  Each of these is a number copied out of the config and left behind when the");
    say("  config moved. None of them breaks anything - that is exactly why they survive.");
  }
  if (skipped.length) say(`  not checked: ${skipped.join(", ")}`);

  say("");
  say("  Read-only. Nothing was changed, and a phrase marked historical (was / used to /");
  say("  superseded / baseline / candidate) is exempt on purpose: a note that SAYS it is");
  say("  history is doing its job, and flagging it would bury the lines that matter.");
  say("=".repeat(100));

  if (EMIT) write(out);
  if (STRICT && findings.length) process.exitCode = 1;
}

function write(out) {
  const p = path.join(PROJECT_ROOT, "tasks", "analysis", "config-drift-latest.txt");
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, out.join("\n") + "\n", "utf8");
    console.log(`\nwritten -> ${p}`);
  } catch (e) { console.error(`could not write report: ${e.message}`); }
}

try { main(); } catch (e) {
  console.error(`UNHANDLED: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
}
