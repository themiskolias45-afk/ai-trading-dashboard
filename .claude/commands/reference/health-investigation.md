# Health investigation procedures — the parts with NO tool behind them

Companion to `/health`. `/health` answers **"is anything wrong?"** by calling tools.
This file answers **"why?"**, and it is prose on purpose: every procedure below is a
method a person or an agent follows, not a script that can be run. Nothing here was
invented for this file — it is the surviving unique content of the eight commands
retired on 2026-09-07 (`checksystem`, `verify`, `errors`, `diagnose`, `debug`,
`status`, `test`, `check`), kept verbatim in substance so nothing is lost.

**Do not build checkers for these.** If one of them later earns a tool, it moves out
of this file and into `/health` as a tool call, and this section says which tool.

---

## A. THE DEBUG LOOP — when something is broken and you do not know why
*(from `debug.md`. Trigger: a specific symptom, reported by a person or a log.)*

### 1. READ THE EVIDENCE FIRST — do NOT look at code yet
Read the last 100 lines of each log that exists:
- `tasks/logs/server_log.txt`
- `tasks/logs/bridge_log_A.txt` — **corrected**: the old files said `bridge_log.txt`;
  both exist, but the tagged one is the live bridge
- `tasks/logs/startup_log.txt`
- `tasks/logs/server_crash.txt` and `tasks/logs/server_err.txt`
- ~~`tasks/logs/error_log.txt`~~ — **named by the old commands but this file does not
  exist.** Kept here so nobody re-derives its absence a third time.

Live state, if the server is running: `get_healer`, `get_signals`, `get_risk_status`.

Look for: `ERROR`, `WARN`, `TypeError`, `ReferenceError`, `SyntaxError`,
`UnhandledPromiseRejection`, `Cannot read prop`, `undefined is not`, `null is not`,
`ECONNREFUSED`, `ENOENT`, `500`, `502`, `503`, `Timeout`, `socket hang up`,
`ETIMEDOUT`, `heap out of memory`.

**Write down EXACTLY what the error says before moving on.**

### 2. FORM ONE HYPOTHESIS — most likely first, one at a time
```
SYMPTOM:    [what is seen / what is wrong]
ERROR:      [exact message or behaviour]
HYPOTHESIS: [root cause — specific, not "something wrong with X"]
CONFIRM BY: [what would prove or DISPROVE it]
```

### 3. CONFIRM THE ROOT CAUSE
Only now read code, and only the part the hypothesis points at — the FULL function.
Trace backwards with the ACTUAL failing input:
```
Call path: [A called B called C]
At C: input was [X], returned [Y], caller expected [Z]
Mismatch at: [exact line]
```
Wrong hypothesis → form a new one and repeat. **Do NOT patch before the cause is confirmed.**

### 4. FIX — minimal, no refactoring while debugging
Trace the fix with the failing input before saving: `before → wrong output`,
`after → correct output`. If it touches `server/index.js`, invoke `code-reviewer` after
committing.

### 5. VERIFY BY RUNNING IT
`node --check <file>` or `python -m py_compile <file>`, then hit the endpoint that was
failing. Confirm the original symptom is gone AND that nothing else broke.

### 6. REPORT + PERSIST
```
ROOT CAUSE: [one sentence]   FIX: [what changed and why]
FILE: [path:line]            COMMIT: [hash]
```
Then `log_note tag="BUG-FIX"` and `write_memory key="bug-[date]"`.

> Never patch around a bug. Never say "this should work now" — verify that it does.

---

## B. THE CAUSE LADDER — when the system runs but takes no trades
*(from `diagnose.md`. Work down in order; stop at the first that fits.)*

State to gather first: `get_signals`, `get_risk_status`, `get_healer`,
`get_journal limit=20`, `get_learning`, and `GET /api/setup-health`
(**session-gated — 401 unauthenticated is expected, not a failure**).

- **A — CIRCUIT BREAKER ACTIVE.** `halted = true` or `consecutiveLosses >= 3`?
  Then trading is halted by design. Ask the second question: is this real losses, or
  losses caused by a system error?
- **B — CONFIDENCE NEVER REACHES THE GATE.** What is the highest confidence across the
  three assets? Read the gate live from `GET /api/strategy-settings`
  (`confidenceThreshold`) — **never hardcode it.** When was confidence last at or above
  it? Ranging market, or broken signal logic?
- **C — SIGNAL STUCK IN WAIT.** Read `generateSignal()` / `generateSignalMTF()` in
  `server/index.js`. What conditions produce `direction !== 'WAIT'`? Is a flag hardcoded,
  a state disabled, a condition always false? Is the healer reporting stale data?
- **D — SETUP HEALTH DISABLING EVERYTHING.** From `/api/setup-health`: any setup AVOID or
  DISABLED? If all are, nothing can fire. Why — win rate, or a manual override?
- **E — MT5 BRIDGE NOT CONNECTED.** `get_mt5_health account=A` is the **only**
  authoritative test; a process list is not a substitute, because Windows returns an
  empty command line for these python processes. Signals can generate and never reach MT5.
- **F — DATA STALENESS BLOCKING SIGNALS.** Is the healer's freshness check failing? Signals
  older than ~60 min can make `generateSignal()` return WAIT as a safety measure.
- **G — SERVER CRASH LOOP.** `tasks/logs/server_log.txt` and `server_starts.txt` for
  repeated restarts. A server restarting every few minutes is never up long enough to fire.
- **H — H4-ONLY CONFIDENCE HARDCODED TO 25.** **HISTORICAL — do not act on this without
  re-measuring.** The original text cited a 65 gate; the live gate has been 70 since
  2026-08-02, and "why confidence is 0" has since been settled separately as three named
  conditions, all measured and upheld. Kept because it is a real past failure shape:
  a per-asset confidence pinned to a constant that can never reach the gate.
- **I — H4-ONLY ON SPX, BY DESIGN.** SPX H4-only confidence is 45 and the gate is 70, so
  SPX will never fire on H4 alone. It requires Daily+H4 agreement. **Correct behaviour** —
  explain it, do not "fix" it.
- **J — API KEY EXPIRED.** If signal generation calls an external API, grep the server log
  for `401`, `403`, `API key`, `authentication`. An expired key falls back to WAIT.

Then trace the exact blocking point: read the FULL relevant function and find which
single condition is false/null/undefined.

**Before any fix**, write the CHANGING / NOW / AFTER / RISK scaffold. If RISK touches
signal generation, the risk gate, lot sizing or stop logic → **stop and show the user.**

---

## C. CODE ANTI-PATTERNS — read by eye, no tool exists
*(from `errors.md`. Applies to `server/index.js` and `server/autohealer.js`.)*

- **a) SILENT FAILURES** — `catch (e) { }`, `catch { }`, `.catch(() => {})`. Swallows the
  error; the bug becomes invisible.
- **b) UNHANDLED PROMISES** — `.then(fn)` with no `.catch(` before the next `.then` or `;`.
- **c) MEMORY LEAKS** — `array.push` inside a loop or interval with no trim/splice/limit.
- **d) INTERVAL LEAKS** — `setInterval(`/`setTimeout(` storing no reference, so it can
  never be cleared.
- **e) MISSING TIMEOUT** — `axios.get(` or `fetch(` with no timeout option.
- **f) HARDCODED THRESHOLDS** that should be configurable. **Note the live values before
  flagging**: the gate is read from `/api/strategy-settings`, and `tasks/config_drift.cjs`
  already checks documented settings against what is running — run that first so this eye
  pass is not re-deriving what a tool already answers.
- **g) UNVALIDATED INPUT** — a route reading `req.body`/`req.query` with no type check.
- **h) MISSING NULL CHECK** before `.length`, `.map`, `.filter`, `.forEach` on API data.

---

## D. LOG SCAN AND CLASSIFICATION
*(from `errors.md`. `/health` reads the doctor's verdict; this is the manual deep read.)*

Read logs **completely**, not the last 50 lines. For each match record
`[file][timestamp][message][count]`, classify as **TRADING-IMPACT / SYSTEM / COSMETIC**,
and **sort most frequent first**. Frequency is the signal: one `ECONNREFUSED` is noise,
two hundred is a broken dependency.

Known so you do not re-derive it: on the laptop, every entry in
`tasks/logs/server_crash.txt` has been a duplicate-server-start `EADDRINUSE` — measured
22 of 22 on 2026-09-07. That file being non-empty is not by itself evidence of a crash.

---

## E. SIGNAL INTEGRITY RULES — checkable by eye against `get_signals`
*(from `errors.md` scan 4, `verify.md` step 5, `test.md` step 4.)*

Read the gate live from `GET /api/strategy-settings`. Then, per asset:
- `signal` is one of `BUY`, `SELL`, `WAIT`; `confidence` is 0–100.
- confidence **≥ gate** and not halted → direction must **NOT** be WAIT.
- confidence **< gate** → direction **MUST** be WAIT.
- if not WAIT: `entry`, `stop`, `target` all present, non-zero and ordered —
  `stop < entry < target` for BUY, reversed for SELL.

Any mismatch is CRITICAL. A `null` stop/target while the signal is WAIT is normal and is
not a mismatch.

---

## F. WRITING A TARGETED TEST
*(from `test.md`. `/health` runs the suite; this is how a NEW test gets written.)*

1. **UNDERSTAND** — read the full file front to back. Identify every path: happy, edge
   (empty, null, zero, very large, exactly at the limit), error (bad input, network down,
   file missing, non-200), boundary (confidence exactly at the gate vs one below; lot
   `0.01` minimum; loss streak `3`).
2. **WRITE** — JS in `server/tests/test_[name].js` with the built-in `assert`; Python
   beside the source with `unittest`. **Name each test what it proves**:
   `test_signal_fires_at_gate_not_one_below()`.
3. **RUN** — `node server/tests/test_[name].js` / `python -m unittest [testfile]`.
   **Fix the code, not the test.** Re-run until all pass.
4. **REPORT** — tests written / passed / failed (must be 0), and which paths are still
   uncovered.

---

## G. THINGS THE OLD COMMANDS GOT WRONG — kept so they are not repeated

- **Four endpoints are session-gated and return 401 unauthenticated by design**:
  `/api/health`, `/api/sentiment`, `/api/performance`, `/api/setup-health`. Four of the
  eight retired commands told you to fetch these and mark them PASS/FAIL, which produced
  four false failures on every run. 401 there is the auth working, not an outage.
- **`tasks/logs/error_log.txt` does not exist** and never did in this tree.
- **`node tasks/api_snapshot.cjs` cannot currently see the performance contract.**
  `tasks/snapshots/performance.schema.json` is literally `{"error":"string"}` — the 401
  body — so `[OK] performance: shape unchanged` compares an error body with itself.
  `signals` and `gate-health` are public and genuinely checked. Not fixed here on purpose:
  fixing it means giving the snapshotter a session, which is a change to a tool, not to
  this command.
- **"Do NOT rely on Python scripts. Run all checks directly"** (from `check.md`) is
  superseded in one direction only: the four `.cjs` tools `/health` calls are not Python
  and are the authority. The spirit stands — do not trust a wrapper that swallows output.
