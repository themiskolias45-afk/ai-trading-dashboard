"""Stops the minimum-R:R gate from erasing the setup it rejects.

The gate still rejects exactly the same trades - risk policy is unchanged and
nothing new becomes tradeable. What changes is that a rejected setup stops being
invisible.

Before: the gate overwrote the entire reasons array and nulled stop/target, leaving
setup "WAIT" and confidence 0. Gold sat at conf 0 for a full day on 2026-08-06 with
one line of explanation, no setup name and no levels - which reads identically to
"no setup formed" and gives the learning engine nothing to work with.

Also fixes the display: toFixed(1) rendered a real 1.45 as "R:R 1.5 below minimum
1.5", a sentence that cannot be true and that appeared verbatim in this morning's
Gold signal.
"""
import io
import sys

PATH = r"C:\ai-trading-dashboard\server\index.js"

OLD = """  // ── Minimum R:R gate ─────────────────────────────────────────
  if (stop !== null && target !== null && signal !== "WAIT") {
    const calcRR = Math.abs(target - entry) / Math.abs(entry - stop);
    if (calcRR < MIN_RR) {
      const badRR = calcRR.toFixed(1);
      setup = "WAIT"; signal = "WAIT"; strength = "NONE";
      stop = null; target = null;
      reasons = [`Setup detected but R:R ${badRR} below minimum ${MIN_RR} — skip`];
    }
  }"""

NEW = """  // ── Minimum R:R gate ─────────────────────────────────────────
  // Rejects the trade, but no longer erases the evidence that a setup existed.
  //
  // This used to overwrite the whole reasons array and null the levels, so a setup
  // missing the bar by 0.05 scored confidence 0 and read exactly like "no setup
  // formed". Gold sat at conf 0 for a full day on 2026-08-06 with one line of
  // explanation, no setup name and no levels - nothing for a human to judge and
  // nothing for the learning engine to see. A near miss and a non-event are not the
  // same fact and must not serialise to the same payload.
  //
  // RISK POLICY IS UNCHANGED: signal still becomes WAIT, so nothing new is tradeable.
  // Only the diagnostics survive.
  //
  // toFixed(2), not toFixed(1): a real 1.45 rendered as "R:R 1.5 below minimum 1.5",
  // a sentence that cannot be true, which is what sent this morning's Gold
  // investigation down the wrong path.
  if (stop !== null && target !== null && signal !== "WAIT") {
    const calcRR = Math.abs(target - entry) / Math.abs(entry - stop);
    if (calcRR < MIN_RR) {
      reasons = [
        `${setup} rejected: R:R ${calcRR.toFixed(2)} below minimum ${MIN_RR} — no trade`,
        `Rejected levels: entry ${entry.toFixed(2)} stop ${stop.toFixed(2)} target ${target.toFixed(2)}`,
        ...reasons,
      ];
      setup = "WAIT"; signal = "WAIT"; strength = "NONE";
      stop = null; target = null;
    }
  }"""

with io.open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

n = src.count(OLD)
print("R:R gate block matches:", n)
if n != 1:
    print("ABORT - expected exactly one match")
    sys.exit(1)

src = src.replace(OLD, NEW)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(src)

print("patched OK")
