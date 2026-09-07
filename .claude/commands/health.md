The one health command. Calls the tools that already exist. Usage: /health [quick|full|why <symptom>]

Replaces `/check` `/checksystem` `/verify` `/errors` `/diagnose` `/debug` `/status` `/test`
(retired 2026-09-07, renamed `.superseded-20260907`, nothing deleted). Those eight were 604
lines of prose and **seven of them called no tool at all** — they told you to do by hand
what `doctor.cjs` and `medic.cjs` already do across both boxes.

**This command runs tools and reports what they printed. It does not re-implement them.**
Never add a check here that a tool already answers. If a check has no tool, it lives in
`reference/health-investigation.md` as prose — do not build a new checker for it.

**READ-ONLY.** Nothing below heals, restarts, writes a setting, decides a proposal or
touches an open position. `--heal`, `--ack`, `--fix` and `--update` are all deliberately
absent. It cannot block a signal or slow the learning engine.

`$ARGUMENTS`: `quick` = sections 1–2 only. `full` or blank = everything.
`why <symptom>` = run section 1, then follow **§A The debug loop** in the reference file.

---

## 1. THE CONTROL PLANE — both boxes, one tool

```
node tasks/doctor.cjs
node tasks/medic.cjs
```

`doctor.cjs` (1555 lines, 80/80 selftest) is the authority on fleet health: it reads THIS
box and the PEER, and carries a remedy per finding. `medic.cjs` triages that output
against the decision ledger and is the only thing that answers **"which findings has
nobody handled?"** — the question all eight retired commands left unasked.

Report, in this order of urgency:
- **REGRESSED** — marked fixed, reported again. A repair did not hold. Lead with this.
- **UNREADABLE** — a finding that could not be keyed. Never skip one.
- **NEW / DUE** — never decided, or the ack expired.
- Then the counts, then `HANDLED`/`CLEARED`.

If medic prints **"THE DOCTOR DID NOT RUN"**, that is a finding, not a pass — nothing about
fleet health is known. Say so plainly.

Recording a decision is a separate, deliberate act and is NOT part of this command:
`node tasks/medic.cjs --ack <id> healed|fixed|accepted|watching|wontfix|escalated "why"`

**Fleet view** — `mcp__smartentry__get_fleet_status`. Read `verdict`, `divergence.gate`,
`parity`. A gate mismatch means the two boxes admit different trades from identical bars
and their journals cannot be pooled. Its `parity` block is CACHED and can be hours old —
if the age matters, run `node tasks/vps_parity.cjs` (exit 2 = engines diverge).

---

## 2. LIVE STATE — one screen

`mcp__smartentry__get_signals`, `get_risk_status`, `get_healer` — in parallel.
Read the gate live from `GET /api/strategy-settings` (`confidenceThreshold`). **Never
hardcode it**; it moved 65 → 70 on 2026-08-02. If `settingsError` is non-null the server
is on built-in defaults, not the saved config — say that before anything else.

```
STATUS — [HH:MM]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SERVER   [ONLINE/OFFLINE]  uptime [Xh Xm]   healer [X/N green]
REGIME   [regime]  session [session]  halted [YES/NO]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BTC      [SIGNAL/WAIT] [conf]%  [WAIT: gap Xpt | last trade Nd ago] [SIGNAL: entry $X stop $X]
GOLD     [same]
SPX      [same]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RISK     daily P&L $X   consecutive losses [X]   open risk [X]%
FLEET    [verdict]  gate here [X] / peer [Y]  parity [verdict, age]
CODE     [CLEAN / SYNTAX ERROR in file]      GIT [CLEAN / X uncommitted]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACTION   [the ONE thing that needs attention, or "Nothing — all clear"]
```

ACTION rules, first match wins:
- server offline → `Start server: tasks\menu.bat option S`
- fleet diverges → `FLEET SPLIT: [what differs]. Pooled numbers are unattributable.`
- medic shows REGRESSED → `REGRESSED: [finding] — a repair did not hold.`
- any healer check not ok → `Force heal: POST /api/healer/heal`
- consecutive losses = 3 → `CIRCUIT BREAKER — trading halted`
- any confidence ≥ the live gate and not halted → `SIGNAL READY: [asset] [direction]`
- syntax error → `SYNTAX ERROR in [file] — /health why syntax`
- git dirty → `Uncommitted changes — commit them`

---

## 3. CODE AND CONTRACT — tools only

```
node --check server/index.js
node --check server/mcp_server.js
node --check server/autohealer.js
python -m py_compile mt5_bridge.py
python -m py_compile parallel_analysis.py
node tasks/batch_syntax_check.cjs      # unescaped ) inside a .bat block
node tasks/claims_check.cjs            # is CLAUDE.md still true
node tasks/api_snapshot.cjs            # endpoint contract (NO --update here)
```

- **claims_check**: exit 0 = claims hold, 1 = STALE claims, 2 = the checker itself broke.
  Report every STALE finding with its suggested fix. **UNVERIFIABLE is not a failure** —
  an offline server and runtime-generated files are expected to be unverifiable. This
  matters more than it looks: CLAUDE.md is loaded at the start of every session, so a wrong
  fact there is not one bad answer, it is a bad premise under every answer that follows.
- **api_snapshot**: exit 0 = shapes unchanged, exit 1 = **an API contract broke (CRITICAL)**.
  A `[WARN] … null this run` line is a value absent, not a shape change — not blocking.
  **Caveat, do not report as green:** its `performance` endpoint is session-gated, and the
  stored schema is the 401 error body, so `[OK] performance` compares an error with itself.
  `signals` and `gate-health` are genuinely checked.
- Report the exact error message for every file that fails. Never summarise a syntax error.

---

## 4. SECRETS — must all come back empty

```
git ls-files server/apikey.txt        # non-empty → ESCALATE: git rm --cached server/apikey.txt
git ls-files keys.env                 # non-empty → ESCALATE: git rm --cached keys.env
git ls-files '*.env'
grep -nE 'sk-ant-|AKIA|password=' server/index.js
```
`.gitignore` must contain `server/apikey.txt`, `keys.env`, `*.env`.
A tracked secret is the one finding here that outranks everything else in this file.

---

## 5. GIT

```
git branch --show-current
git status --short
git log --oneline -3
```
Flag uncommitted changes to `server/index.js` or `dashboard/` specifically — those two
conflict on every pull, which is why the standing rule is to commit immediately.

---

## 6. ENDPOINTS — know which 401s are correct

Public, must return 200: `/api/status` `/api/signals` `/api/gate-health`
`/api/strategy-settings` `/api/mt5/health?account=A`

**Session-gated — 401 unauthenticated is CORRECT and is not a failure:**
`/api/health` `/api/sentiment` `/api/performance` `/api/setup-health` `/api/journal`
`/api/risk-status` `/api/fleet` `/api/system-plan`

Four of the eight retired commands marked these FAIL on every run. Reach them through the
MCP tools, which hold their own login, or log in first. **Never report a 401 here as an
outage**, and never "fix" it by opening the route.

Freshness, when the payload is in hand: signals within ~30 min, sentiment within ~2 h,
healer 6/6. Bridge liveness is `get_mt5_health account=A` and nothing else — a process
list is not a substitute. **An empty `/api/mt5/positions` can mean the bridge is not
reporting, not that the box is flat.** After a server restart the bridge legitimately reads
silent for one post cycle (~30–60 s); check `tasks/logs/server_starts.txt` before calling
it down.

---

## 7. VERDICT

```
HEALTH — [timestamp]
════════════════════════════════════════
FLEET     [verdict] | doctor [R red / A amber / I info] | medic [N unhandled]
SYNTAX    [PASS — X files / FAIL — file: exact error]
CLAIMS    [HOLD / X STALE]        CONTRACT [unchanged / BROKE: endpoint]
SECRETS   [CLEAN / ESCALATE — file tracked]
GIT       branch [name] | [CLEAN / X uncommitted]
LIVE      BTC [sig conf%] GOLD [sig conf%] SPX [sig conf%] | gate [X] | halted [Y/N]

REGRESSED / UNHANDLED:
  [each, with its medic id]

FAILURES (fix before trading):
  1. [exact problem] → [exact fix]

WARNINGS:
  [worth knowing, not blocking]
────────────────────────────────────────
VERDICT: GREEN / YELLOW / RED
```

- **GREEN** — every tool exited clean AND medic reports nothing unhandled.
- **YELLOW** — warnings, or findings that are handled and explained.
- **RED** — a tool failed, a contract broke, a secret is tracked, or medic shows REGRESSED.

**A check that failed to run is not a pass.** If a tool could not execute, say which and
why; do not fold it into GREEN. Silence is not health.

Then: `Fix required — fix now?` on RED, or
`System clean — [N] tools run, 0 failures, 0 unhandled findings.` on GREEN.

---

## WHY, NOT WHAT

`/health` finds problems. **`reference/health-investigation.md`** diagnoses them, and holds
every instruction from the eight retired commands that has no tool behind it:

- **§A the debug loop** — evidence → one hypothesis → confirm → minimal fix → verify → persist
- **§B the cause ladder A–J** — why no trades are opening (was `/diagnose`)
- **§C code anti-patterns a–h** — silent catches, unhandled promises, leaks, missing timeouts
- **§D log scan** — token list, TRADING-IMPACT/SYSTEM/COSMETIC, sort by frequency
- **§E signal integrity rules** — what a valid signal must satisfy
- **§F writing a targeted test** — the `/test [thing]` method
- **§G what the old commands got wrong** — the 401s, the log that never existed, the
  snapshot that measures nothing

Read §A before touching code. Write the **CHANGING / NOW / AFTER / RISK** scaffold before
the first line. If RISK touches signal generation, the gate, sizing or stop logic —
**stop and show the user.**
