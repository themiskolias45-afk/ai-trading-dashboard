'use strict';
/**
 * Is this system getting smarter, and how fast?
 *
 * The Performance tab already tracks P&L growth. On a system this young that chart
 * is nearly blank and will stay thin for months - not because it refuses to trade,
 * it fills about once every 4 days, but because it has only been running weeks - so
 * it cannot yet answer "is today better than yesterday". Measuring the wrong thing
 * and finding nothing looks identical to standing still.
 *
 * What IS growing is evidence. Every gate rejection is a fully priced paper trade
 * that tasks/score_rr_rejections.py walks forward on real bars, so the system
 * accumulates resolved episodes daily without funding a single one. That is the
 * binding constraint on everything else: the live learning engine refuses to act
 * on a setup below LEARNING_THRESHOLD closed outcomes, and at roughly a trade a
 * week the real journal will not reach it this year. The shadow ledger can.
 *
 * So this tracks the curve that actually moves, and states plainly how far it is
 * from the number that unlocks a decision.
 *
 * READ-ONLY. Reads two files and returns arithmetic. Feeds no gate, no
 * confidence, no sizing.
 */

const fs   = require("fs");
const path = require("path");

const SCORED_PATH  = path.join(__dirname, "..", "tasks", "rejections_scored.jsonl");
// The floor getLearningBoost() enforces before a setup may influence anything.
const LEARNING_THRESHOLD = 5;
const VELOCITY_WINDOW_DAYS = 7;

function readScored(filePath) {
  try {
    return fs.readFileSync(filePath || SCORED_PATH, "utf8")
      .split("\n").map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) {
    return null;
  }
}

const isResolved = row => row.outcome === "TARGET" || row.outcome === "STOP";
const dayOf = row => (row.ts || "").slice(0, 10);

/** Fill the gaps so a quiet day reads as zero rather than vanishing from the curve. */
function everyDayBetween(first, last) {
  const out = [];
  const cursor = new Date(first + "T00:00:00Z");
  const end = new Date(last + "T00:00:00Z");
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function build(options) {
  const settings = options || {};
  const rows = readScored(settings.scoredPath);
  if (rows === null) {
    return { available: false, reason: "no scored ledger yet", days: [], setups: [] };
  }
  if (!rows.length) {
    return { available: false, reason: "scored ledger is empty", days: [], setups: [] };
  }

  // ── EPISODES, NOT ROWS ─────────────────────────────────────────────────────
  // Every label this module produces is episode language - ai_brief.cjs prints its
  // output as "resolved paper episodes" and "setups with enough paper episodes to
  // read" - while the arithmetic below counted ROWS, and nothing in between converted
  // the unit. Gates re-fire on every 30-minute refresh, so one setup drifting across a
  // few hours writes many near-identical rows: measured on the live ledger today, 3799
  // rows collapse to 305 episodes, so the brief was overstating the evidence roughly
  // twelvefold. score_rr_rejections.py:548 states the doctrine plainly - "seven rows of
  // one Gold short are one piece of evidence, not seven" - and stamps an `episode` id on
  // every row it writes. This module was the one reader that ignored it.
  //
  // Same rule and same tie-break as score_rr_rejections.py's episodes_from_scored:696:
  // the EARLIEST RESOLVED row in an episode is its verdict, and if nothing in it
  // resolved the first row stands, so a pending episode still appears as pending rather
  // than vanishing. The synthetic fallback key mirrors learning_from_rejections.py so a
  // row written before the id existed stays distinct instead of collapsing on null -
  // verified unnecessary today (0 of 3799 rows lack the field), and kept because "true
  // today" is not the same as "true when this next runs".
  const byEpisode = new Map();
  for (const row of [...rows].sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")))) {
    const key = row.episode != null
      ? row.episode
      : ["row", row.ts, row.setup, row.entry].join("|");
    const held = byEpisode.get(key);
    if (!held || (!isResolved(held) && isResolved(row))) byEpisode.set(key, row);
  }
  const episodes = [...byEpisode.values()];

  // ── daily buckets ──────────────────────────────────────────────────────────
  const buckets = {};
  for (const row of episodes) {
    const day = dayOf(row);
    if (!day) continue;
    buckets[day] = buckets[day] || { logged: 0, resolved: 0, wins: 0, losses: 0 };
    buckets[day].logged++;
    if (isResolved(row)) {
      buckets[day].resolved++;
      if (row.outcome === "TARGET") buckets[day].wins++; else buckets[day].losses++;
    }
  }
  const dated = Object.keys(buckets).sort();
  const days = [];
  let cumulativeLogged = 0, cumulativeResolved = 0;
  for (const date of everyDayBetween(dated[0], dated[dated.length - 1])) {
    const b = buckets[date] || { logged: 0, resolved: 0, wins: 0, losses: 0 };
    cumulativeLogged += b.logged;
    cumulativeResolved += b.resolved;
    days.push({
      date,
      logged: b.logged, resolved: b.resolved, wins: b.wins, losses: b.losses,
      cumulativeLogged, cumulativeResolved,
    });
  }

  // ── per-setup progress toward the threshold that unlocks the engine ────────
  const bySetup = {};
  for (const row of rows) {
    if (!isResolved(row)) continue;
    const setup = row.setup || "UNKNOWN";
    bySetup[setup] = bySetup[setup] || { resolved: 0, wins: 0, losses: 0, netR: 0 };
    const s = bySetup[setup];
    s.resolved++;
    if (row.outcome === "TARGET") s.wins++; else s.losses++;
    s.netR += Number.isFinite(row.r) ? row.r : (row.outcome === "TARGET" ? (Number(row.rr) || 1) : -1);
  }
  const setups = Object.entries(bySetup).map(([setup, s]) => ({
    setup,
    resolved: s.resolved, wins: s.wins, losses: s.losses,
    netR: Number(s.netR.toFixed(3)),
    winRate: s.resolved ? Math.round((s.wins / s.resolved) * 100) : null,
    usable: s.resolved >= LEARNING_THRESHOLD,
    stillNeeded: Math.max(0, LEARNING_THRESHOLD - s.resolved),
  })).sort((a, b) => b.resolved - a.resolved);

  // ── velocity, and what it implies ──────────────────────────────────────────
  const recent = days.slice(-VELOCITY_WINDOW_DAYS);
  const recentResolved = recent.reduce((sum, d) => sum + d.resolved, 0);
  const perDayRecent = recent.length ? recentResolved / recent.length : 0;
  const perDayAll = days.length ? cumulativeResolved / days.length : 0;

  const notYet = setups.filter(s => !s.usable);
  const projections = notYet.map(s => ({
    setup: s.setup,
    stillNeeded: s.stillNeeded,
    // Rate for THIS setup, not the whole ledger: a setup appearing once a week
    // does not inherit the ledger's aggregate speed.
    daysAtCurrentRate: (() => {
      const own = days.length ? s.resolved / days.length : 0;
      return own > 0 ? Math.ceil(s.stillNeeded / own) : null;
    })(),
  })).sort((a, b) => (a.daysAtCurrentRate ?? 1e9) - (b.daysAtCurrentRate ?? 1e9));

  return {
    available: true,
    days,
    setups,
    totals: {
      logged: cumulativeLogged,
      resolved: cumulativeResolved,
      pending: cumulativeLogged - cumulativeResolved,
      trackedDays: days.length,
      usableSetups: setups.filter(s => s.usable).length,
      setupsTracked: setups.length,
    },
    velocity: {
      resolvedPerDayRecent: Number(perDayRecent.toFixed(2)),
      resolvedPerDayAllTime: Number(perDayAll.toFixed(2)),
      windowDays: VELOCITY_WINDOW_DAYS,
      // The comparison that answers "is it speeding up or stalling".
      trend: perDayRecent > perDayAll * 1.1 ? "ACCELERATING"
           : perDayRecent < perDayAll * 0.9 ? "SLOWING" : "STEADY",
    },
    projections,
    learningThreshold: LEARNING_THRESHOLD,
    feedsTheGate: false,
    note: "Evidence growth, not P&L. These are forgone PAPER trades walked forward "
      + "on real bars — no spread, no slippage, entries never filled. They are how "
      + "fast the system is learning, NOT what it earned. Realised P&L lives on the "
      + "Performance tab and rests on a handful of fills - the system is weeks old, "
      + "so that number is young, not stalled.",
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { build, readScored, LEARNING_THRESHOLD };
