/* ============================================================================
   AGENT AUTH CHECK — will the CLI agents still be able to sign in tomorrow?
   ============================================================================

   WHY THIS EXISTS

   On 2026-08-28 the VPS OAuth session expired and both autonomous agents died at
   the auth layer. Nothing watched for it. The doctor caught it only indirectly,
   by reading scheduled-task exit codes a day later, and the note it left behind
   pointed at the wrong cause.

   Worse, on 2026-08-29 it was diagnosed WRONG TWICE — declared fixed while the
   agents were still dead. That is the trap this file exists to make impossible:

   ** AN API-KEY PROBE CANNOT TEST AGENT AUTH. **

   There are two independent auth paths on each box and they fail independently:

     API key (ANTHROPIC_API_KEY)  ->  server/index.js SDK calls
     subscription OAuth           ->  EVERY CLI AGENT

   claude_agent.py:606 REMOVES ANTHROPIC_API_KEY on purpose, so agents bill the
   claude.ai subscription rather than pay-as-you-go credit — that credit ran out
   on 2026-08-03 and every agent died in 5-9 seconds. So `claude -p` run with the
   key set returns exit 0 while the agents are dead. It proves nothing.

   WHY THIS READS A FILE INSTEAD OF PROBING

   Running `claude -p` to test auth costs real usage on every check, and a check
   that costs money gets run less often, which is the opposite of what a monitor
   is for. The credentials file already carries the answer:

     expiresAt              the ACCESS token. Auto-refreshes. NOT the thing to
                            watch — it is routinely hours away and that is normal.
     refreshTokenExpiresAt  the REFRESH token. When THIS lapses you get
                            "OAuth session expired and could not be refreshed"
                            and a human has to run /login. THIS is the alarm.

   Watching expiresAt would fire every single day and teach you to ignore it.

   WHAT IT CHECKS
     1. the credentials file exists and parses
     2. refreshTokenExpiresAt is in the future, with WARN_DAYS of runway
     3. subscriptionType is a subscription, not API billing
     4. SMARTENTRY_AGENT_USE_API_KEY is not set — because setting it silently
        moves every agent onto pay-as-you-go credit, which is the 2026-08-03
        failure waiting to happen again

   It reads one file and writes one JSON. It never prints a token, never calls
   the API, never touches a credential, and cannot affect a signal, a gate, an
   order or a position.

   EXIT CODES follow this project's convention:
     0  healthy
     3  NEEDS A PERSON — expired, expiring inside WARN_DAYS, or billing moved.
        3 rather than 1 because a scheduled task showing 3 means "parked, a human
        must act", and 1 means "it crashed". This never crashes.

   Usage: node tasks/agent_auth_check.cjs [--warn-days N] [--json] [--quiet]
   ============================================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CREDS = path.join(os.homedir(), ".claude", ".credentials.json");

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/* --out exists because a TEST RUN MUST NOT CLOBBER THE LIVE ARTIFACT.
   Verifying the expired path means pointing HOME at a fixture directory — but
   the output path is derived from __dirname, not from HOME, so the simulated
   "session expired 3 days ago" overwrote the real dashboard/agent-auth.json and
   the Fleet Map then reported this box as EXPIRED while it was perfectly healthy.
   Caught in test, which is the only reason it is not live now. Point tests here. */
const OUT = opt("--out", path.join(ROOT, "dashboard", "agent-auth.json"));
/* 7 days. The refresh token has run ~30 days from issue, so a week is enough
   warning to act on a weekday without being so early it becomes background
   noise. An alarm that fires for a month is an alarm nobody reads. */
const WARN_DAYS = Number(opt("--warn-days", "7"));
const QUIET = process.argv.includes("--quiet");
const AS_JSON = process.argv.includes("--json");

const findings = [];
let state = "OK";
const escalate = (level) => {
  const rank = { OK: 0, WARN: 1, RED: 2 };
  if (rank[level] > rank[state]) state = level;
};

const report = {
  generatedAt: new Date().toISOString(),
  box: os.hostname(),
  credentialsPath: CREDS.replace(os.homedir(), "~"),
  present: false,
  subscriptionType: null,
  rateLimitTier: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  daysUntilReauth: null,
  usingApiKeyForAgents: false,
  warnDays: WARN_DAYS,
  state: "OK",
  findings,
  // Stated in the payload so no reader has to remember it.
  note: "Watches refreshTokenExpiresAt, not expiresAt: the access token refreshes "
      + "itself and is routinely hours away, which is normal. An API-key probe cannot "
      + "test this — claude_agent.py strips ANTHROPIC_API_KEY so agents bill the "
      + "subscription.",
  remedy: "On that box run `claude` then `/login` (with the leading slash) and choose "
        + "the Claude subscription, not the API key.",
  feedsTheGate: false,
};

/* Setting this moves every CLI agent onto pay-as-you-go credit. Checked because
   it is invisible otherwise: agents would keep working right up until the credit
   runs out, then all die at once, which is exactly what happened 2026-08-03. */
if (process.env.SMARTENTRY_AGENT_USE_API_KEY === "1") {
  report.usingApiKeyForAgents = true;
  findings.push({
    level: "WARN",
    title: "Agents are on API credit, not the subscription",
    detail: "SMARTENTRY_AGENT_USE_API_KEY=1 is set, so claude_agent.py keeps "
          + "ANTHROPIC_API_KEY and every agent bills pay-as-you-go. When that credit "
          + "runs out every agent dies at once. Unset it to return to the subscription.",
  });
  escalate("WARN");
}

let raw = null;
try {
  raw = fs.readFileSync(CREDS, "utf8");
  report.present = true;
} catch (e) {
  findings.push({
    level: "RED",
    title: "No credentials file — the CLI has never signed in on this box",
    detail: `${report.credentialsPath} could not be read (${e.code || e.message}). `
          + "Every CLI agent on this box will fail at the auth layer.",
  });
  escalate("RED");
}

if (raw !== null) {
  let oauth = null;
  try {
    oauth = (JSON.parse(raw) || {}).claudeAiOauth || null;
  } catch (e) {
    findings.push({
      level: "RED",
      title: "Credentials file is present but unreadable",
      detail: `It did not parse as JSON (${e.message}). A corrupt credentials file `
            + "fails exactly like an expired one, and only re-running /login fixes it.",
    });
    escalate("RED");
  }

  if (oauth === null && report.present && findings.every(f => f.title.indexOf("unreadable") === -1)) {
    findings.push({
      level: "RED",
      title: "No claudeAiOauth block in the credentials file",
      detail: "The file exists but carries no subscription session, so the CLI has "
            + "nothing to authenticate the agents with.",
    });
    escalate("RED");
  }

  if (oauth) {
    report.subscriptionType = oauth.subscriptionType || null;
    report.rateLimitTier = oauth.rateLimitTier || null;

    const asIso = (ms) => (Number.isFinite(Number(ms))
      ? new Date(Number(ms)).toISOString() : null);
    report.accessTokenExpiresAt = asIso(oauth.expiresAt);
    report.refreshTokenExpiresAt = asIso(oauth.refreshTokenExpiresAt);

    // A subscription session with NO refresh expiry cannot be judged, and must not
    // be reported as healthy just because the field is missing.
    if (report.refreshTokenExpiresAt === null) {
      findings.push({
        level: "WARN",
        title: "No refreshTokenExpiresAt to check",
        detail: "The session carries no refresh-token expiry, so this check cannot say "
              + "when a re-login will be needed. It is not saying the session is fine.",
      });
      escalate("WARN");
    } else {
      const days = (Date.parse(report.refreshTokenExpiresAt) - Date.now()) / 86400000;
      report.daysUntilReauth = Number(days.toFixed(1));
      if (days <= 0) {
        findings.push({
          level: "RED",
          title: "Subscription session has EXPIRED — agents cannot authenticate",
          detail: `The refresh token lapsed ${Math.abs(days).toFixed(1)} day(s) ago. `
                + "Every CLI agent on this box fails with \"OAuth session expired and "
                + "could not be refreshed\" until someone signs in.",
        });
        escalate("RED");
      } else if (days <= WARN_DAYS) {
        findings.push({
          level: "WARN",
          title: `Subscription session expires in ${days.toFixed(1)} day(s)`,
          detail: "Re-authenticate before it lapses; once it does, every autonomous "
                + "run on this box parks until a human signs in.",
        });
        escalate("WARN");
      }
    }

    // "max" / "pro" are subscriptions. Anything else means the agents are not on
    // the plan the design assumes, and the billing note above becomes live.
    const sub = String(report.subscriptionType || "").toLowerCase();
    if (sub && sub !== "max" && sub !== "pro" && sub !== "team" && sub !== "enterprise") {
      findings.push({
        level: "WARN",
        title: `Session reports subscriptionType "${report.subscriptionType}"`,
        detail: "claude_agent.py assumes a claude.ai subscription. If this session is "
              + "API billing, agents draw pay-as-you-go credit instead of the plan.",
      });
      escalate("WARN");
    }
  }
}

report.state = state;

try {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
} catch (e) {
  // A monitor that cannot publish still has to say what it found.
  if (!QUIET) console.error(`[agent-auth] could not write ${path.relative(ROOT, OUT)}: ${e.message}`);
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else if (!QUIET) {
  const days = report.daysUntilReauth;
  console.log(`[agent-auth] ${report.box}: ${state} — subscription `
    + `${report.subscriptionType || "unknown"}`
    + (days === null ? ", re-auth date unknown" : `, re-auth needed in ${days} day(s)`));
  for (const f of findings) console.log(`  ${f.level}: ${f.title}`);
  if (state !== "OK") console.log(`  remedy: ${report.remedy}`);
}

// 3, not 1: this never crashes, and a 3 tells the scheduler a human must act.
process.exit(state === "RED" || state === "WARN" ? 3 : 0);
