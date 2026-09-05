"use strict";
/*
 * The /api/settings environment guard.
 *
 * WHY THIS TEST EXISTS. On 2026-09-05 /api/settings was changed to apply saved keys to
 * process.env so a key saved in the UI works without a restart. That change removed a
 * containment nobody had written down: the keys.env boot loader assigns a variable ONLY
 * when it is undefined, and PATH / COMSPEC / PROGRAMFILES / LOCALAPPDATA are always
 * defined, so a poisoned keys.env had always been inert at startup. Applying
 * unconditionally in a request handler made the child-process launch environment
 * writable over HTTP.
 *
 * The sanitiser is what makes it reachable rather than what prevents it: safeKey
 * uppercases and strips to [A-Z0-9_], so "path" BECOMES "PATH" and "comspec" BECOMES
 * "COMSPEC" — and process.env on Windows is case-insensitive, so assigning PATH
 * overwrites the real Path.
 *
 * This test reads PROTECTED_ENV_KEYS and the safeKey expression OUT OF server/index.js
 * rather than restating them, so it fails if either is weakened. A test carrying its own
 * copy of the list would keep passing after someone shortened the real one.
 *
 *   node --test server/settings_env_guard.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

// ── pull the real list out of the real file ─────────────────────────────────────
function readProtectedSet() {
  const start = SRC.indexOf("const PROTECTED_ENV_KEYS = new Set([");
  assert.notStrictEqual(start, -1, "PROTECTED_ENV_KEYS is gone from server/index.js");
  const end = SRC.indexOf("]);", start);
  assert.notStrictEqual(end, -1, "PROTECTED_ENV_KEYS block is unterminated");
  const body = SRC.slice(start, end);
  return new Set([...body.matchAll(/"([A-Z0-9_]+)"/g)].map(m => m[1]));
}

// The transform the handler actually applies to a caller-supplied key name.
const safeKey = key => String(key).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

const PROTECTED = readProtectedSet();

// A literal newline written into this file by an editing script keeps breaking the
// source, so the character is built rather than typed.
const BSLASH_N = String.fromCharCode(10);

test("the guard is still wired into the handler", () => {
  // Both call sites matter. The first keeps a refused name out of keys.env, so it cannot
  // lie dormant in the file and apply at the next restart; the second is the loop with
  // teeth. Losing either one silently restores the hole.
  assert.ok(
    SRC.includes("if (PROTECTED_ENV_KEYS.has(safeKey)) { refusedKeys.push(safeKey); continue; }"),
    "the custom-key loop no longer refuses protected names — a blocked key would reach keys.env"
  );
  assert.ok(
    SRC.includes("if (PROTECTED_ENV_KEYS.has(envKey)) continue;"),
    "the process.env apply loop no longer skips protected names"
  );
});

test("every name the reviewer demonstrated is refused, in the casing an attacker would send", () => {
  // Lower case on purpose: safeKey CREATES the dangerous name from harmless-looking input,
  // which is exactly why a naive "the user would have to type PATH" argument is wrong.
  const attacks = [
    "path", "PATH", "Path", "pathext",
    "comspec", "COMSPEC", "ComSpec",
    "node_options", "NODE_OPTIONS", "node_path",
    "smartentry_python", "SMARTENTRY_PYTHON",
    "programfiles", "ProgramFiles", "localappdata", "LocalAppData",
    "pythonpath", "pythonhome", "pythonstartup",
    "systemroot", "windir", "temp", "tmp",
  ];
  for (const raw of attacks) {
    const key = safeKey(raw);
    assert.ok(PROTECTED.has(key), `${JSON.stringify(raw)} sanitises to ${key}, which is NOT protected`);
  }
});

test("the trading controls that take effect without a restart are refused", () => {
  // MT5_EXPECTED_ACCOUNTS decides whether ensure_running starts a bridge on an account
  // this box does not own, on a 10-minute schedule — the one outcome that doubles every
  // trade. PEER_SERVER_URL decides which machine every fleet-divergence answer describes.
  for (const raw of ["mt5_expected_accounts", "MT5_EXPECTED_ACCOUNTS", "peer_server_url", "peer_heartbeat_expect"]) {
    assert.ok(PROTECTED.has(safeKey(raw)), `${raw} must be refused`);
  }
});

test("ordinary API keys are still settable — the guard must not break the feature", () => {
  // The point of `custom` rows is arbitrary keys. A guard that refuses everything would
  // be safe and useless; this is the case that proves it still does its job.
  for (const raw of ["brave_api_key", "BRAVE_API_KEY", "openai_api_key", "some_new_service_token"]) {
    assert.ok(!PROTECTED.has(safeKey(raw)), `${raw} should NOT be refused`);
  }
});

test("prototype keys cannot reach the updates object", () => {
  assert.strictEqual(safeKey("__proto__"), "__PROTO__");
  assert.strictEqual(safeKey("constructor"), "CONSTRUCTOR");
  assert.strictEqual(safeKey("prototype"), "PROTOTYPE");
});

test("a value can never inject a second line into keys.env", () => {
  // sanitizeEnvValue is what keeps one saved value from becoming two env entries.
  const m = SRC.match(/function sanitizeEnvValue\(v\)\s*\{([^}]*)\}/);
  assert.ok(m, "sanitizeEnvValue is gone");
  assert.ok(/replace\(\s*\/\[\\r\\n\]\/g/.test(m[1]), "sanitizeEnvValue no longer strips CR/LF");
});

test("the boot loader still fills only UNSET keys", () => {
  // This is the containment the handler guard now mirrors. If the loader is ever changed
  // to assign unconditionally, a poisoned keys.env becomes live at startup and the
  // handler guard alone is not enough.
  assert.ok(
    SRC.includes("process.env[key] === undefined) process.env[key] = value"),
    "the keys.env boot loader no longer skips already-defined variables"
  );
});

// ── keys.env must never be lost ─────────────────────────────────────────────────
// writeKeysEnv used to be a bare truncating writeFileSync over the ONLY copy of every
// secret on the box: DASHBOARD_PASSWORD, SLACK_BOT_TOKEN, NOTION_TOKEN, TV_PASSWORD.
// keys.env is gitignored, so a crash between truncate and write lost all of them with
// no recovery path anywhere. These assert the two properties that fix it, read out of
// the real source so they fail if either is removed.

test("writeKeysEnv takes a backup and ABORTS if the backup is missing", () => {
  const fn = SRC.slice(SRC.indexOf("function writeKeysEnv(updates)"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.ok(body.includes("fs.copyFileSync(KEYS_ENV_PATH, backup)"),
    "writeKeysEnv no longer copies keys.env before rewriting it");
  assert.ok(/refusing to rewrite it/.test(body),
    "writeKeysEnv no longer ABORTS when the backup could not be created — " +
    "a backup that is attempted but not verified is not a backup");
});

test("writeKeysEnv replaces atomically, and never writes the live file unbacked", () => {
  const fn = SRC.slice(SRC.indexOf("function writeKeysEnv(updates)"));
  const body = fn.slice(0, fn.indexOf(BSLASH_N + "function "));

  assert.ok(body.includes("fs.renameSync(tempPath, KEYS_ENV_PATH)"),
    "writeKeysEnv no longer renames a temp file into place — the atomic path is gone");

  // THE PROPERTY THAT ACTUALLY MATTERS is not "never truncate". A truncating write is
  // only UNRECOVERABLE when no verified copy of the old contents exists. There is a
  // direct write here on purpose: it is the fallback for a destination locked by a
  // reader, measured as a real HTTP 500 otherwise. What must hold is that EVERY write to
  // the live file happens AFTER the backup has been taken and size-verified.
  const verifyAt = body.indexOf("backup is missing or truncated");
  assert.notStrictEqual(verifyAt, -1, "the backup size verification is gone");

  const writes = [...body.matchAll(/fs\.(writeFileSync|renameSync)\([^)]*KEYS_ENV_PATH/g)];
  assert.ok(writes.length > 0, "nothing writes keys.env at all any more");
  for (const w of writes) {
    assert.ok(w.index > verifyAt,
      `a write to keys.env at offset ${w.index} happens BEFORE the backup is verified ` +
      `(verification is at ${verifyAt}) — that write could destroy the only copy`);
  }

  // And the fallback must announce itself: a silent downgrade from atomic to truncating
  // is exactly the kind of thing that gets rediscovered during an incident.
  assert.ok(/falling back to a direct write/.test(body),
    "the direct-write fallback no longer logs that it fired");
});

test("a keys.env backup can never be committed", () => {
  // A secrets backup that git can see is a worse bug than the one the backup fixes.
  const ignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.ok(/^keys\.env\*/m.test(ignore), ".gitignore no longer globs keys.env*");
  assert.ok(/^\*\.bak-\*/m.test(ignore), ".gitignore no longer globs *.bak-*");
});
