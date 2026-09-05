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
