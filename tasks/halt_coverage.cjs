// HALT COVERAGE — when you halt, does everything actually stop?
//
// THE QUESTION THIS ANSWERS. server/index.js already states the rule: "ANY COMPONENT
// THAT CAN PLACE AN ORDER MUST CHECK BOTH AND FAIL CLOSED ON EITHER", and warns that "a
// switch that stops some of them is worse than one that stops none, because you believe
// you are flat and may trade manually on top of positions that are still opening."
//
// Traced 2026-09-06, every order path on this fleet:
//
//   mt5_bridge.py         checks BOTH halt systems, fails closed        COVERED
//   tasks/fvg_executor.py checks BOTH, fails closed (crt/fvg/tk models) COVERED
//   audit_all_trades.py   no order_send, and says so in its header      n/a
//   diagnose_orphan_close no order_send                                 n/a
//   list_broker_symbols   no order_send                                 n/a
//   EA_CRT_AMD (chart)    reads NEITHER route. 36 real trades placed.   NOT COVERED
//   TK_SMART_ENTRY(chart) reads neither, but reports Mode=MANUAL        NOT COVERED
//
// So the Python side is genuinely closed. The CHART EAs are not, and cannot be: they run
// inside MetaTrader and never call the server.
//
// WHY THIS DOES NOT JUST TURN AUTOTRADING OFF. It cannot. Verified on the VPS: the
// MetaTrader5 Python API exposes terminal_info().trade_allowed for READING and has no
// setter for it — the only "setters" in the module are unrelated symbol constants. The
// remaining ways to disable AutoTrading are sending Ctrl+E keystrokes to a live trading
// terminal or editing common.ini and restarting it. Neither belongs in an automated
// safety tool: a flaky keystroke against the process that holds open positions is a
// worse failure than the one it is trying to prevent.
//
// SO THIS REPORTS RATHER THAN ACTS, DELIBERATELY. It converts a silent gap into a loud
// one at the moment it matters — when you have halted and believe you are flat. Being
// told "the halt is PARTIAL and gold is still armed" is the whole value; a reader who
// knows can act in ten seconds, and a reader who does not know cannot act at all.
//
//   node tasks/halt_coverage.cjs           report + write dashboard/halt-coverage.json
//   node tasks/halt_coverage.cjs --json    machine-readable, write nothing
//
// exit 0 = halt is complete, or nothing is halted
// exit 1 = HALT IS PARTIAL — something can still place an order
// exit 2 = could not tell, which is never reported as "fine"
//
// Read-only over HTTP GETs and one JSON file. Places no order, changes no setting.

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dashboard", "halt-coverage.json");
const RUNTIME = path.join(ROOT, "dashboard", "mt5-runtime-status.json");
const AS_JSON = process.argv.includes("--json");
const TIMEOUT_MS = 4000;

function get(pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 3001, path: pathname, timeout: TIMEOUT_MS }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ __err: "HTTP " + res.statusCode });
        try { resolve(JSON.parse(body)); } catch { resolve({ __err: "unparseable" }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ __err: "timeout" }); });
    req.on("error", (e) => resolve({ __err: e.code || e.message }));
  });
}
const bad = (o) => !o || o.__err;

function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME, "utf8")); }
  catch (e) { return { __err: e.message }; }
}

(async function main() {
  const control = await get("/api/mt5/control");
  const risk = await get("/api/risk-status");
  const runtime = readRuntime();

  // Either system saying stop means stopped. Unreadable is NOT "not halted" — the whole
  // point of this tool is that unknown must never read as safe.
  const killSwitchOff = bad(control) ? null
    : (control.enabled === false || control.tradingEnabled === false || control.halted === true);
  const breakerOpen = bad(risk) ? null : risk.halted === true;
  const halted = killSwitchOff === true || breakerOpen === true;
  const haltUnknown = killSwitchOff === null || breakerOpen === null;

  // What can still place an order while halted.
  const stillArmed = [];
  if (!bad(runtime)) {
    if (runtime.algoTradingAllowed === 1) {
      if (runtime.eaAttached === true && runtime.eaName) {
        stillArmed.push({
          what: runtime.eaName,
          why: "a chart EA. It reads neither /api/mt5/control nor /api/risk-status, and " +
               "AutoTrading is ON (algoTradingAllowed=1), so a halt does not reach it.",
          basis: runtime.eaAttachBasis || null,
        });
      } else if (runtime.eaAttached === false) {
        // No EA seen. Not the same as none attached -- say which.
        stillArmed.push({
          what: "AutoTrading is ON with no EA currently detected",
          why: "algoTradingAllowed=1, so any EA attached from the terminal would trade " +
               "immediately and outside both halt systems.",
          basis: runtime.eaAttachBasis || null,
        });
      }
    }
  }

  const coveredPaths = [
    { path: "mt5_bridge.py", covered: true, detail: "checks both halt systems, fails closed" },
    { path: "tasks/fvg_executor.py (crt / fvg / tk)", covered: true, detail: "checks both, fails closed" },
  ];

  let verdict, exitCode;
  if (haltUnknown || bad(runtime)) {
    verdict = "CANNOT TELL";
    exitCode = 2;
  } else if (!halted) {
    verdict = stillArmed.length
      ? "NOT HALTED — and if you halt, " + stillArmed.length + " path(s) would keep trading"
      : "NOT HALTED";
    exitCode = 0;
  } else if (stillArmed.length) {
    verdict = "HALT IS PARTIAL";
    exitCode = 1;
  } else {
    verdict = "HALT IS COMPLETE";
    exitCode = 0;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    feedsTheGate: false,
    verdict,
    halted,
    killSwitchEngaged: killSwitchOff,
    circuitBreakerOpen: breakerOpen,
    algoTradingAllowed: bad(runtime) ? null : (runtime.algoTradingAllowed ?? null),
    coveredPaths,
    stillArmed,
    // The one action that closes it, stated here so a reader never has to go looking.
    remedy: stillArmed.length
      ? "MetaTrader cannot be told to stop trading over its Python API — terminal_info()." +
        "trade_allowed is readable and has no setter. To stop a chart EA you must press " +
        "Ctrl+E in the terminal (or remove the EA from the chart). Until then a halt " +
        "stops the bridge and the executors and NOT the chart EAs."
      : null,
    note: "Read-only. Places no order, changes no setting, and cannot itself halt anything.",
  };

  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(exitCode); }

  const tmp = OUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2), "utf8");
  fs.renameSync(tmp, OUT);

  console.log("\n=== HALT COVERAGE ===\n");
  console.log("  verdict            " + verdict);
  console.log("  kill switch        " + (killSwitchOff === null ? "unreadable" : killSwitchOff ? "ENGAGED" : "off"));
  console.log("  circuit breaker    " + (breakerOpen === null ? "unreadable" : breakerOpen ? "OPEN" : "closed"));
  console.log("  AutoTrading        " + (report.algoTradingAllowed === null ? "unreadable" : report.algoTradingAllowed === 1 ? "ON" : "off"));
  console.log("\n  covered order paths:");
  coveredPaths.forEach((p) => console.log("    [ok]  " + p.path + " — " + p.detail));
  if (stillArmed.length) {
    console.log("\n  NOT COVERED:");
    stillArmed.forEach((s) => {
      console.log("    [!!]  " + s.what);
      console.log("          " + s.why);
    });
    console.log("\n  " + report.remedy);
  } else {
    console.log("\n  nothing outside the halt systems can place an order.");
  }
  console.log("");
  process.exit(exitCode);
})();
