#!/usr/bin/env node
"use strict";
/**
 * THE MEDIC - every doctor finding gets a decision, or it is NEW and gets surfaced.
 *
 *   node tasks/medic.cjs                    triage both boxes; exit 1 if anything needs you
 *   node tasks/medic.cjs --json             machine-readable, for a surface to render
 *   node tasks/medic.cjs --ack <id> <action> "why" [--review 7]
 *   node tasks/medic.cjs --list             what is on the ledger right now
 *   node tasks/medic.cjs --selftest         prove the detector fires
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE DOCTOR
 * tasks/doctor.cjs diagnoses both boxes, carries a remedy per finding, heals the safe
 * subset, and self-tests 80/80. It is not the gap. The gap is that it runs ONCE A DAY on
 * each box and produces 18 findings, and NOTHING RECORDS WHETHER ANYONE EVER READ ONE.
 * On 2026-09-05 the standing set included two REDs that had been red for seven days,
 * five peer proposals nobody had decided, and a post-close harness that had measured
 * nothing since 09-03. Every one was correctly detected and correctly reported, every
 * day, to nobody.
 *
 * So this detects nothing. It answers a different question: WHICH FINDINGS ARE
 * UNHANDLED? A finding is handled when it is on the ledger with an action and a reason.
 * Anything else is NEW, REGRESSED or DUE, and this exits non-zero until it is not.
 *
 * "Never ignore an error or a warning" is unenforceable while ignoring one leaves no
 * trace. This makes ignoring one impossible to do silently: the only way to stop a
 * finding being reported is to say, on the record, what you decided and why. INFO is
 * tracked exactly like RED - a rule that exempts the quiet severities is precisely how
 * the quiet ones accumulate.
 *
 * THE ID MUST BE STATIONARY, and that is the whole design.
 * The id hashes box + what with DIGITS NORMALISED OUT, and deliberately excludes `why`,
 * which carries live counts, ages and timestamps. Hashing volatile text would mint a new
 * id every run: the finding would be permanently NEW, the ledger would grow without
 * bound and never match, and this would be decoration. That is not hypothetical - it is
 * how the near-miss census keyed itself into thousands of unjoinable rows a day. "5
 * proposal(s)" and "7 proposal(s)" are the SAME standing finding at a different count.
 *
 * SAFETY - bound by the four standing rules it was asked for:
 *   NEVER BLOCKS LEARNING.  It writes one file, its own append-only ledger. It does not
 *                           touch learning.json, any journal, the calibration record,
 *                           the rejection ledger or the shadow ledger.
 *   NEVER BLOCKS A SIGNAL.  No gate, no threshold, no setup, no confidence, no sizing,
 *                           no order path. feedsTheGate is false and stays false. It
 *                           cannot admit or suppress a trade.
 *   NEVER IGNORES AN ERROR. Every severity is tracked. A finding it cannot key is
 *                           reported as UNREADABLE rather than skipped, a corrupt ledger
 *                           line is reported rather than skipped, and a doctor that fails
 *                           to run is itself a finding - silence is never read as health.
 *   NEVER DELETES.          The ledger is append-only. A revision is a new line and the
 *                           last line wins, so the history of what was decided and when
 *                           survives. Nothing is ever rewritten or removed.
 * It changes NOTHING on either box. Healing stays with the doctor, which already vets
 * and self-tests its own remedies.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LEDGER = path.join(__dirname, "medic_ledger.jsonl");

// What an acknowledgement can say. `accepted` is the load-bearing one: a finding that is
// true, understood and deliberately not being changed - laptop sleep, both boxes holding
// the same position on purpose. Without it, the only way to silence a permanent truth is
// to pretend it was fixed, and a ledger full of false "fixed" is worse than no ledger.
const ACTIONS = ["healed", "fixed", "accepted", "watching", "wontfix", "escalated"];
const ACTION_SET = new Set(ACTIONS);

// An acknowledgement is not forever. Past this, a finding STILL being reported comes
// back as DUE - "I looked at it once" is not "it is handled", and an ack with no expiry
// is how a real problem gets permanently silenced by one careless note.
const DEFAULT_REVIEW_DAYS = 14;
const ACCEPTED_REVIEW_DAYS = 90; // a standing truth still gets re-read, just rarely.

function stationaryId(box, what) {
  const key = String(box + "|" + what)
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return { rows: [], byId: new Map() };
  const rows = [];
  const raw = fs.readFileSync(LEDGER, "utf8").split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      // A corrupt line is REPORTED, never skipped silently - skipping is the exact
      // failure mode this file exists to prevent.
      rows.push({ __unreadable: true, __line: i + 1, __text: line.slice(0, 120) });
    }
  }
  const byId = new Map();
  for (const r of rows) if (!r.__unreadable && r.id) byId.set(r.id, r); // last line wins
  return { rows, byId };
}

function appendLedger(entry) {
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n", "utf8");
}

function runDoctor() {
  // The doctor already reaches BOTH boxes in one run - findings carry
  // box: "this box" | "local" | "peer" | "fleet". Shelling out rather than requiring it
  // keeps a doctor crash from taking this process down with it. It exits 1 whenever it
  // has findings, which is the normal case, so the exit code is not treated as failure.
  const args = [path.join(__dirname, "doctor.cjs"), "--json"];
  try {
    return JSON.parse(execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000,
    }));
  } catch (err) {
    if (err && typeof err.stdout === "string" && err.stdout.trim()) {
      return JSON.parse(err.stdout); // exit 1 with a valid report is the normal path
    }
    throw err;
  }
}

function daysBetween(aMs, bMs) {
  return (bMs - aMs) / (1000 * 60 * 60 * 24);
}

function triage(doctorReport, ledgerIndex, now) {
  now = now || new Date();
  const findings = Array.isArray(doctorReport.findings) ? doctorReport.findings : [];
  const seen = new Set();
  const buckets = { NEW: [], REGRESSED: [], DUE: [], HANDLED: [], UNREADABLE: [] };

  for (const f of findings) {
    if (!f || typeof f.what !== "string" || typeof f.box !== "string") {
      buckets.UNREADABLE.push({ raw: f });
      continue;
    }
    const id = stationaryId(f.box, f.what);
    seen.add(id);
    const prior = ledgerIndex.get(id) || null;
    const item = {
      id, severity: f.severity, box: f.box, what: f.what, why: f.why,
      remedy: f.remedy, healable: !!f.healable, prior,
    };

    if (!prior) { buckets.NEW.push(item); continue; }

    // Claimed fixed, and the doctor is still reporting it. This is the most important
    // state this tool can produce: the repair did not hold.
    if (prior.action === "healed" || prior.action === "fixed") {
      buckets.REGRESSED.push(item);
      continue;
    }

    const reviewDays = Number.isFinite(prior.reviewDays)
      ? prior.reviewDays
      : (prior.action === "accepted" ? ACCEPTED_REVIEW_DAYS : DEFAULT_REVIEW_DAYS);
    const age = daysBetween(new Date(prior.ts).getTime(), now.getTime());
    if (age > reviewDays) {
      item.ageDays = age;
      item.reviewDays = reviewDays;
      buckets.DUE.push(item);
    } else {
      buckets.HANDLED.push(item);
    }
  }

  // On the ledger, no longer reported. Not a finding - but worth knowing, because a
  // "fixed" that stopped being reported is the only evidence a repair actually held.
  const cleared = [];
  for (const entry of ledgerIndex) {
    const id = entry[0], row = entry[1];
    if (!seen.has(id)) cleared.push(Object.assign({ id }, row));
  }

  return { buckets, cleared, total: findings.length };
}

function fmt(item) {
  const lines = [];
  lines.push("  [" + item.severity + "] " + item.box + ": " + item.what);
  lines.push("      id:  " + item.id);
  if (item.why) lines.push("      why: " + item.why);
  if (item.remedy) lines.push("      fix: " + item.remedy + (item.healable ? "   (HEALABLE)" : ""));
  if (item.prior) {
    lines.push("      was: " + item.prior.action + " on " + String(item.prior.ts).slice(0, 10) +
               (item.prior.note ? ' - "' + item.prior.note + '"' : ""));
  }
  return lines.join("\n");
}

function cmdTriage(asJson) {
  let report;
  try {
    report = runDoctor();
  } catch (err) {
    // A doctor that cannot run is itself the finding. Reporting health here because the
    // check failed would be the exact "green over a dead component" this project keeps
    // being bitten by.
    const msg = "medic: THE DOCTOR DID NOT RUN - " +
                String((err && err.message) || err).split("\n")[0];
    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: msg, feedsTheGate: false }));
    } else {
      console.log(msg);
      console.log("  This is a finding, not a pass. Nothing about fleet health is known right now.");
      console.log("  fix: node tasks/doctor.cjs   (read the failure directly)");
    }
    process.exit(2);
  }

  const led = readLedger();
  const corrupt = led.rows.filter(function (r) { return r.__unreadable; });
  const t = triage(report, led.byId);
  const buckets = t.buckets;

  const need = buckets.NEW.length + buckets.REGRESSED.length + buckets.DUE.length +
               buckets.UNREADABLE.length + corrupt.length;

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      generatedAt: new Date().toISOString(),
      doctorGeneratedAt: report.generatedAt,
      totalFindings: t.total,
      counts: {
        new: buckets.NEW.length, regressed: buckets.REGRESSED.length, due: buckets.DUE.length,
        handled: buckets.HANDLED.length, unreadable: buckets.UNREADABLE.length,
        corruptLedgerLines: corrupt.length, cleared: t.cleared.length,
      },
      new: buckets.NEW, regressed: buckets.REGRESSED, due: buckets.DUE,
      handled: buckets.HANDLED, cleared: t.cleared,
      feedsTheGate: false,
    }, null, 2));
    process.exit(need ? 1 : 0);
  }

  const bar = "=".repeat(96);
  console.log(bar);
  console.log("  MEDIC - " + t.total + " doctor finding(s) across both boxes, " +
              led.byId.size + " on the ledger");
  console.log(bar);

  if (corrupt.length) {
    console.log("\nCORRUPT LEDGER LINES (" + corrupt.length + ") - reported, never skipped");
    for (const c of corrupt) console.log("  line " + c.__line + ": " + c.__text);
  }
  if (buckets.UNREADABLE.length) {
    console.log("\nUNREADABLE FINDINGS (" + buckets.UNREADABLE.length +
                ") - the doctor emitted a shape this cannot key");
    for (const u of buckets.UNREADABLE) console.log("  " + JSON.stringify(u.raw).slice(0, 160));
  }
  if (buckets.REGRESSED.length) {
    console.log("\nREGRESSED (" + buckets.REGRESSED.length +
                ") - marked fixed, and back. The repair did not hold.");
    for (const i of buckets.REGRESSED) console.log(fmt(i));
  }
  if (buckets.NEW.length) {
    console.log("\nNEW (" + buckets.NEW.length + ") - never decided by anyone");
    for (const i of buckets.NEW) console.log(fmt(i));
  }
  if (buckets.DUE.length) {
    console.log("\nDUE FOR RE-READ (" + buckets.DUE.length +
                ") - acknowledged, still true, ack has expired");
    for (const i of buckets.DUE) {
      console.log(fmt(i));
      console.log("      age: " + i.ageDays.toFixed(1) + "d against a " + i.reviewDays + "d review");
    }
  }
  if (buckets.HANDLED.length) {
    console.log("\nHANDLED (" + buckets.HANDLED.length + ") - on the ledger, decision still current");
    for (const i of buckets.HANDLED) {
      console.log("  [" + i.severity + "] " + i.box + ": " + i.what);
      console.log('      ' + i.prior.action + ' - "' + (i.prior.note || "") + '" (' +
                  String(i.prior.ts).slice(0, 10) + ")");
    }
  }
  if (t.cleared.length) {
    console.log("\nCLEARED (" + t.cleared.length + ") - on the ledger, no longer reported by the doctor");
    for (const c of t.cleared) {
      console.log("  " + c.id + "  " + c.box + ": " + c.what + "  [was " + c.action + "]");
    }
  }

  console.log("\n" + bar);
  if (!need) {
    console.log("  Every finding on both boxes has a recorded decision. Nothing is unread.");
    console.log(bar);
    process.exit(0);
  }
  console.log("  " + need + " finding(s) need a decision. Recording one is the only way to clear it:");
  console.log("    node tasks/medic.cjs --ack <id> " + ACTIONS.join("|") + ' "why" [--review <days>]');
  console.log(bar);
  process.exit(1);
}

function cmdAck(argv) {
  const id = argv[0];
  const action = argv[1];
  const note = argv[2];
  const rIdx = argv.indexOf("--review");
  const reviewDays = rIdx >= 0 ? Number(argv[rIdx + 1]) : undefined;

  if (!id || !action) {
    console.error('usage: node tasks/medic.cjs --ack <id> <action> "why" [--review <days>]');
    console.error("       action = " + ACTIONS.join(" | "));
    process.exit(2);
  }
  if (!ACTION_SET.has(action)) {
    console.error('medic: "' + action + '" is not an action. Use one of: ' + ACTIONS.join(", "));
    process.exit(2);
  }
  // A decision with no reason is not a decision - it is the finding being silenced,
  // which is the thing this tool exists to make impossible.
  if (!note || !String(note).trim()) {
    console.error("medic: a reason is REQUIRED. An acknowledgement with no note is how a real");
    console.error("       problem gets permanently silenced by one careless keystroke.");
    process.exit(2);
  }
  if (reviewDays !== undefined && (!Number.isFinite(reviewDays) || reviewDays <= 0)) {
    console.error("medic: --review takes a positive number of days");
    process.exit(2);
  }

  let report;
  try {
    report = runDoctor();
  } catch (err) {
    console.error("medic: cannot ack - the doctor did not run (" +
                  String((err && err.message) || err).split("\n")[0] + ")");
    process.exit(2);
  }

  let match = null;
  for (const f of (report.findings || [])) {
    if (f && f.what && f.box && stationaryId(f.box, f.what) === id) { match = f; break; }
  }
  if (!match) {
    console.error("medic: no CURRENT finding has id " + id + ".");
    console.error("       Acking something the doctor is not reporting would put a decision on");
    console.error("       the ledger for a problem nobody can see. Run: node tasks/medic.cjs");
    process.exit(2);
  }

  const entry = {
    ts: new Date().toISOString(),
    id: id,
    action: action,
    note: String(note).trim(),
    box: match.box,
    what: match.what,
    severity: match.severity,
  };
  if (reviewDays !== undefined) entry.reviewDays = reviewDays;
  appendLedger(entry);

  const window = reviewDays !== undefined ? reviewDays
    : (action === "accepted" ? ACCEPTED_REVIEW_DAYS : DEFAULT_REVIEW_DAYS);
  console.log("medic: recorded " + action + " for " + id + " - " + match.box + ": " + match.what);
  console.log('       "' + entry.note + '"');
  console.log("       re-read in " + window + " days");
}

function cmdList() {
  const led = readLedger();
  const corrupt = led.rows.filter(function (r) { return r.__unreadable; });
  if (corrupt.length) {
    console.log("(" + corrupt.length + " corrupt line(s) in the ledger - reported, not skipped)");
  }
  if (!led.byId.size) {
    console.log("medic ledger is empty - no finding has been decided yet.");
    return;
  }
  console.log("medic ledger - " + led.byId.size + " decided finding(s), " +
              led.rows.length + " row(s) of history:\n");
  for (const entry of led.byId) {
    const id = entry[0], r = entry[1];
    console.log("  " + id + "  [" + r.severity + "] " + r.box + ": " + r.what);
    console.log('      ' + r.action + " on " + String(r.ts).slice(0, 10) + ' - "' + (r.note || "") + '"');
  }
}

// ---- selftest: a check nobody has seen fire is a comment ------------------------
function selftest() {
  let failed = 0;
  function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name +
                (ok ? "" : " - got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
  }

  // THE load-bearing property: the id must not move when the counts move.
  const a = stationaryId("peer", "5 AI proposal(s) nobody has decided");
  const b = stationaryId("peer", "7 AI proposal(s) nobody has decided");
  check("id is stationary across a changing count", a === b, true);
  check("id still separates different findings",
        stationaryId("peer", "job Daily Check: FAILING") === a, false);
  check("id separates the same finding on different boxes",
        stationaryId("local", "job X: FAILING") === stationaryId("peer", "job X: FAILING"), false);

  const now = new Date("2026-09-05T00:00:00Z");
  function F(sev, box, what) {
    return { severity: sev, box: box, what: what, why: "w", remedy: "r", healable: false };
  }
  function ledgerOf(box, what, action, ts) {
    const id = stationaryId(box, what);
    return new Map([[id, { id: id, action: action, note: "n", ts: ts, box: box, what: what }]]);
  }

  let t = triage({ findings: [F("RED", "peer", "job X: FAILING")] }, new Map(), now);
  check("an undecided finding is NEW", [t.buckets.NEW.length, t.buckets.HANDLED.length], [1, 0]);

  t = triage({ findings: [F("RED", "peer", "job X: FAILING")] },
             ledgerOf("peer", "job X: FAILING", "accepted", "2026-09-01T00:00:00Z"), now);
  check("a recent acknowledgement is HANDLED",
        [t.buckets.HANDLED.length, t.buckets.NEW.length], [1, 0]);

  t = triage({ findings: [F("RED", "peer", "job X: FAILING")] },
             ledgerOf("peer", "job X: FAILING", "fixed", "2026-09-04T00:00:00Z"), now);
  check("marked fixed but still reported is REGRESSED", t.buckets.REGRESSED.length, 1);

  t = triage({ findings: [F("RED", "peer", "job X: FAILING")] },
             ledgerOf("peer", "job X: FAILING", "watching", "2026-07-01T00:00:00Z"), now);
  check("an expired acknowledgement comes back as DUE", t.buckets.DUE.length, 1);

  t = triage({ findings: [F("RED", "peer", "job X: FAILING")] },
             ledgerOf("peer", "job X: FAILING", "accepted", "2026-08-20T00:00:00Z"), now);
  check("accepted is not DUE at 16 days", t.buckets.DUE.length, 0);

  t = triage({ findings: [F("RED", "peer", "job X: FAILING")] },
             ledgerOf("peer", "job X: FAILING", "accepted", "2026-01-01T00:00:00Z"), now);
  check("accepted IS due at 247 days - no ack is forever", t.buckets.DUE.length, 1);

  t = triage({ findings: [F("INFO", "local", "something quiet")] }, new Map(), now);
  check("INFO is tracked like every other severity", t.buckets.NEW.length, 1);

  t = triage({ findings: [] },
             ledgerOf("peer", "gone away", "fixed", "2026-09-04T00:00:00Z"), now);
  check("a finding that stopped being reported is CLEARED", t.cleared.length, 1);

  t = triage({ findings: [{ severity: "RED" }] }, new Map(), now);
  check("a malformed finding is UNREADABLE, not dropped", t.buckets.UNREADABLE.length, 1);

  console.log(failed === 0
    ? "selftest: OK - every state this tool can report has been seen to fire"
    : "selftest: " + failed + " case(s) wrong - this check cannot be trusted");
  return failed === 0 ? 0 : 2;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.indexOf("--selftest") >= 0) process.exit(selftest());
  if (argv.indexOf("--list") >= 0) return cmdList();
  const ackIdx = argv.indexOf("--ack");
  if (ackIdx >= 0) return cmdAck(argv.slice(ackIdx + 1));
  return cmdTriage(argv.indexOf("--json") >= 0);
}

main();
