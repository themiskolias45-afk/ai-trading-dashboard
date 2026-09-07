"""Persists every setup the minimum-R:R gate rejects, with its full levels.

Purpose: measure MIN_RR without risking money on it. The walk-forward harness only
sweeps confidence gates - "gate and every lower threshold yields an identical list" -
so MIN_RR = 1.5 has never been measured and cannot be with the existing tool. Moving
it would swap one assumption for another.

A rejected setup is a fully specified trade: entry, stop and target are all computed
before the gate fires. Recording them turns each rejection into a paper trade that can
be scored against what price actually did, which is the only way to learn whether the
1.35-1.49 band wins without funding the experiment.

Deduped on the level signature. The gate re-fires on every refresh and for each
timeframe, so without this the file would collect ~144 near-identical rows a day and
the dataset would be worthless. One row per distinct set of levels.

Fails silently by design: a logging fault must never propagate into signal generation.
"""
import io
import sys

PATH = r"C:\ai-trading-dashboard\server\index.js"

ANCHOR = """const MT5_CANDLE_MAX_AGE_MS = 15 * 60 * 1000;"""

HELPER = """const MT5_CANDLE_MAX_AGE_MS = 15 * 60 * 1000;

// ── R:R rejection shadow log ──────────────────────────────────
// Every setup killed by the minimum-R:R gate, recorded with the levels it would have
// traded. MIN_RR has never been measured - the walk-forward harness sweeps confidence
// gates only - so this is how the 1.35-1.49 band gets evidence instead of a guess.
//
// A rejection is a complete trade: entry, stop and target are all computed before the
// gate fires. Scored later against actual price, each row answers "would this have
// won" at zero risk.
const RR_REJECTED_PATH = path.join(__dirname, "..", "tasks", "rr_rejected.jsonl");

// The gate re-fires on every refresh and once per timeframe. Without deduping on the
// levels themselves the file would fill with ~144 near-identical rows a day and the
// dataset would be useless for measuring anything.
const rrRejectedLastSignature = new Map();

function logRrRejection(record) {
  try {
    const signature = [
      record.ticker, record.setup, record.direction,
      record.entry, record.stop, record.target,
    ].join("|");
    if (rrRejectedLastSignature.get(record.ticker) === signature) return;
    rrRejectedLastSignature.set(record.ticker, signature);
    fs.appendFileSync(RR_REJECTED_PATH, JSON.stringify(record) + "\\n");
  } catch (e) {
    // Never let a logging fault reach signal generation - this is observability,
    // not a trading path.
    console.error("[rr-reject] could not record rejection:", e.message);
  }
}"""

OLD_GATE = """    if (calcRR < MIN_RR) {
      reasons = [
        `${setup} rejected: R:R ${calcRR.toFixed(2)} below minimum ${MIN_RR} — no trade`,
        `Rejected levels: entry ${entry.toFixed(2)} stop ${stop.toFixed(2)} target ${target.toFixed(2)}`,
        ...reasons,
      ];
      setup = "WAIT"; signal = "WAIT"; strength = "NONE";
      stop = null; target = null;
    }"""

NEW_GATE = """    if (calcRR < MIN_RR) {
      logRrRejection({
        ts:        new Date().toISOString(),
        ticker,
        label,
        setup,
        direction: signal,
        entry:     Number(entry.toFixed(2)),
        stop:      Number(stop.toFixed(2)),
        target:    Number(target.toFixed(2)),
        rr:        Number(calcRR.toFixed(3)),
        minRr:     MIN_RR,
        // Only variables provably in scope in generateSignal: rsi (declared L747) and
        // trend (L760). regime and adx live on the MTF wrapper, not here - referencing
        // them would be a ReferenceError that node --check cannot catch and that would
        // take down signal generation for every asset.
        trend:     trend ?? null,
        rsi:       rsi ?? null,
      });
      reasons = [
        `${setup} rejected: R:R ${calcRR.toFixed(2)} below minimum ${MIN_RR} — no trade`,
        `Rejected levels: entry ${entry.toFixed(2)} stop ${stop.toFixed(2)} target ${target.toFixed(2)}`,
        ...reasons,
      ];
      setup = "WAIT"; signal = "WAIT"; strength = "NONE";
      stop = null; target = null;
    }"""

with io.open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

for name, block in (("anchor", ANCHOR), ("gate", OLD_GATE)):
    n = src.count(block)
    print("  %-7s: %d match(es)" % (name, n))
    if n != 1:
        print("ABORT - expected exactly one match")
        sys.exit(1)

src = src.replace(ANCHOR, HELPER)
src = src.replace(OLD_GATE, NEW_GATE)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(src)

print("patched OK")
