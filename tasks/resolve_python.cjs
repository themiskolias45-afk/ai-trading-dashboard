// Print the interpreter server/python_path.js resolves, so .bat and .ps1 callers get the
// SAME answer the Node side gets.
//
// WHY AN ADAPTER RATHER THAN A SECOND IMPLEMENTATION
// server/python_path.js already probes candidates by RUNNING them, covers both the
// per-user (LOCALAPPDATA\Programs\Python\*) and all-users (Program Files\Python*)
// installs, and keeps bare "python" last so a working box selects exactly what it
// selected before. Re-implementing that in PowerShell and again in batch would give
// three answers that drift apart, and the first time they disagreed nobody would know
// which one was right. There is one resolver; this file is a mouthpiece for it.
//
// CONTRACT
//   exit 0 + the binary on stdout   a working interpreter was found
//   exit 1 + nothing on stdout      nothing on this box runs, and the caller decides
//                                   whether to refuse or to try bare "python" anyway
//
// Callers that cannot sensibly refuse should fall back to "python", which is exactly
// what they did before this existed: this can make a broken box work, it cannot make a
// working box worse.
const path = require("path");

let bin = null;
try {
  bin = require(path.join(__dirname, "..", "server", "python_path.js")).pythonBin();
} catch (err) {
  // A missing or broken module must not take the caller down with it. Exit 1 and let
  // the caller fall back, rather than throwing a stack trace into a bridge launcher.
  process.stderr.write("resolve_python: " + (err && err.message ? err.message : err) + "\n");
  process.exit(1);
}

if (!bin) process.exit(1);
process.stdout.write(bin);
