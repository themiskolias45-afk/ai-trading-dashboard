// Resolve the Python interpreter ONCE, by running each candidate, and remember it.
//
// WHY THIS EXISTS
// Every call site used to hardcode bare "python" and let PATH decide which binary that
// meant. On 2026-08-23 Windows Smart App Control began blocking the unsigned
// uv-installed interpreter, while the user PATH resolved "python" to a uv trampoline
// pointing at exactly that blocked binary. Every Python call on the laptop then died
// with "uv trampoline failed to spawn Python child process (os error 4551)" - the MT5
// bridge, the nightly rejection-ledger pipeline, the daily plan, and both persist tools
// at once, for 8h32m, behind a healer reading 8/8 green. PATH ORDER IS NOT SOMETHING
// THIS SYSTEM SHOULD BE BETTING ON.
//
// A candidate is accepted only if it actually RUNS. Existing on disk is not enough:
// the blocked interpreter exists, is the right size, has a valid signature, and fails
// at exec. `-c` is used rather than `--version` because the trampoline prints its
// error and exits non-zero without ever starting Python, so requiring real stdout from
// a real interpreter is the discriminating test.
//
// SAFETY PROPERTY: bare "python" stays in the candidate list as the last resort, so on
// any box where today's behaviour works, this module selects exactly what it selected
// before. It can make a broken box work; it cannot make a working box worse.

const { spawnSync } = require("child_process");
const path = require("path");

// undefined = not tried yet | null = nothing on this box works | string = the binary
let resolved;

// Probing costs one short-lived process per candidate and happens once per process.
// Kept low so a hung interpreter cannot stall boot.
const PROBE_TIMEOUT_MS = 15000;

function candidates() {
  const list = [];
  // An explicit override always wins, so a box with an unusual layout needs no code
  // change and no redeploy - set SMARTENTRY_PYTHON in that machine's keys.env.
  if (process.env.SMARTENTRY_PYTHON) list.push(process.env.SMARTENTRY_PYTHON);

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      // Newest first. These are the per-user python.org installs, which are signed and
      // are what Smart App Control permits.
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        list.push(path.join(localAppData, "Programs", "Python", version, "python.exe"));
      }
    }
    list.push("python");  // whatever PATH says - the previous behaviour, kept last
    list.push("py");
  } else {
    list.push("python3", "python");
  }
  return list;
}

function runs(binary) {
  try {
    const probe = spawnSync(binary, ["-c", "import sys; sys.stdout.write('pyok')"], {
      encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true,
    });
    // r.error covers ENOENT and the timeout; a non-zero status covers the trampoline,
    // which fails after the file is found. Both must be treated as "not usable".
    return !probe.error && probe.status === 0 && (probe.stdout || "").includes("pyok");
  } catch (_) {
    return false;
  }
}

// The interpreter to spawn, or null when this box has none that works. Callers that
// must distinguish "no Python at all" from "the script failed" should use this one:
// reporting a spawn failure as script output is how log_note and write_memory answered
// ok:true while writing nothing.
function pythonBin() {
  if (resolved !== undefined) return resolved;
  resolved = null;
  for (const candidate of candidates()) {
    if (runs(candidate)) { resolved = candidate; break; }
  }
  return resolved;
}

// For callers with no sensible way to handle "no Python": behave exactly as the old
// hardcoded constant did and let the spawn fail where it always failed.
function pythonBinOrDefault() {
  return pythonBin() || (process.platform === "win32" ? "python" : "python3");
}

// What was tried, for an error message that names the problem instead of hiding it.
function tried() { return candidates(); }

module.exports = { pythonBin, pythonBinOrDefault, tried };
