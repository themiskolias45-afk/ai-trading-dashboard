# SmartEntry Evidence Court — self-learning that can prove its own claims

**Status:** planned, not built. Written 2026-08-06.
**Scope:** both machines — laptop (`C:\Users\User\ai-trading-dashboard`) and Contabo VPS
(`C:\ai-trading-dashboard`, 169.58.74.133).
**Owner task:** see `[PLAN] Evidence Court` in the task list.

---

## 1. Why this exists

JARVIS is blind in a specific, diagnosable way: **the system cannot currently prove any
claim it makes about itself.** Evidence from 2026-08-06, all verified that day:

| Blind spot | Evidence |
|---|---|
| Config drift is invisible | `CLAUDE.md` asserted the gate was 70 while the laptop ran 50 and the VPS ran 65 — three numbers, one system |
| A number can go live without anyone choosing it | `confidenceThreshold=50` was inert until `d320785` removed sizing.js's 65 clamp; it became load-bearing via an unrelated bug fix |
| The same gate existed in three places | engine threshold, `sizing.js MIN_CONFIDENCE=65`, and a hardcoded `60` inside the AI-filter prompt |
| Execution can be dead while every health check is green | VPS placed zero orders for 11 days on retcode 10027; healer, `/api/mt5/health` and the heartbeat were all green throughout |
| Proposals are generated and discarded | the morning agent filed the *same* finding verbatim on 08-04, 08-05 and 08-06, each time noting no operator had acted |
| Calibration cannot be measured at all | `get_performance` returns `setups: {"error":"Not logged in."}` — `/api/stats/by-setup` is in neither auth allowlist |
| Constraints are never validated | `MIN_RR = 1.5` has no folds behind it; the walk-forward harness sweeps confidence gates only |
| A whole asset can be silently excluded | Gold's setups were erased by the R:R gate, serialising identically to "no setup formed" |

None of these were caused by bad judgement. They were caused by **there being no place
where a claim, its evidence, and its verdict live together.** That is the thing to build.

---

## 2. The principle

> **No configuration change without a verdict. No verdict without evidence. No evidence
> without provenance.**

Every number that affects trading — `confidenceThreshold`, `MIN_RR`, `minStrength`,
`adxTrendingMin`, `maxTradesPerDay`, `maxConcurrentPositions`, spread caps, the AI
filter's bar — is owned by a **champion record**. Changing it requires a **challenger**
to win in **court**.

This is not ceremony. Today's session found three separate hardcoded copies of one gate
precisely because no registry said which value was authoritative.

---

## 3. Architecture

### 3.1 Evidence Ledger — `evidence/ledger.jsonl` (append-only)

Every measurable fact, with provenance. Immutable: corrections are new rows that
supersede, never edits.

```json
{
  "id": "ev-2026-08-06-0001",
  "ts": "2026-08-06T09:41:00Z",
  "claim": "gate 70 is positive in 5/5 out-of-sample folds",
  "harness": "tasks/mtf_walkforward.cjs",
  "harnessCommit": "b55b5f5",
  "dataWindow": "2021-08..2026-08",
  "sampleSize": 412,
  "result": { "folds": 5, "positive": 5, "pf": 1.31 },
  "supersedes": null,
  "box": "vps"
}
```

Why append-only: on 2026-08-03 a superseded walk-forward run from a *broken* harness sat
in `tasks/logs/mtf_walkforward.txt` alongside a good one, distinguishable only by
timestamp. Provenance must be structural, not a reading comprehension exercise.

### 3.2 Champion Registry — `evidence/champion.json`

For each parameter: current value, the verdict that installed it, its evidence refs,
install date, and **per-box status**.

```json
{
  "confidenceThreshold": {
    "value": 70,
    "verdict": "vd-2026-08-06-0003",
    "evidence": ["ev-2026-08-06-0001"],
    "installedAt": "2026-08-06T09:41:00Z",
    "boxes": { "local": 50, "vps": 70 },
    "inSync": false
  }
}
```

`inSync: false` is the alarm that did not exist today. The registry answers *"why is the
gate 70?"* with a citation instead of a recollection.

### 3.3 Challengers — `evidence/challengers/`

A proposed change plus its **pre-declared** success criteria, registered *before*
measurement runs. Pre-declaration is the whole point: it makes post-hoc rationalisation
structurally impossible.

Sources: morning-agent proposals, shadow-log scoring, walk-forward sweeps, manual.

### 3.4 The Court — deterministic adjudication

Rules, not vibes:

1. **Standing.** A challenger with fewer than the declared minimum samples gets
   `INSUFFICIENT EVIDENCE` — never a pass, never a fail. Today's daily rule already says
   no judgement under 5 trades per setup; the court enforces it.
2. **Burden of proof is on the challenger.** Ties go to the champion. Incumbency is a
   real advantage because the champion has survived live conditions.
3. **Out-of-sample only.** Positive in ≥4/5 folds *and* not negative in any single fold.
   A challenger carried by one lucky stretch loses.
4. **Cross-examination.** An adversarial agent argues *against* the challenger and must
   be answered on the record. Use the existing `code-reviewer` / `analyst` agents.
5. **Verdict** — `PROMOTE` / `REJECT` / `INSUFFICIENT EVIDENCE`, with reasons and
   evidence refs, written to `evidence/verdicts.jsonl`. Permanent.
6. **No verdict, no change.** A parameter edited outside this process is a defect and the
   parity checker reports it as drift.

### 3.5 Evidence collectors — fixing the blindness

The court is worthless without inputs. **Phase 0 exists because there is currently almost
nothing to judge.**

| Collector | State | Needed |
|---|---|---|
| R:R rejection shadow log | **built** 2026-08-06 (`tasks/rr_rejected.jsonl`) | the scorer |
| Calibration by setup | blocked — `/api/stats/by-setup` 401s to MCP | allowlist it |
| Walk-forward sweeps | confidence gates only | extend to `MIN_RR`, `minStrength`, `adxTrendingMin` |
| Closed-trade record | 2 lifetime trades | see §6 |
| Rejected-trade shadow | R:R only | extend to every gate that kills a setup |

### 3.6 Parity enforcement

`strategy_settings.json` is per-machine and untracked, so a shared commit does **not**
mean shared behaviour. Today: laptop 50, VPS 70. A parity checker compares live config on
both boxes against the champion registry and alerts on divergence.

Must write config with `[System.IO.File]::WriteAllText($p,$json,(New-Object
System.Text.UTF8Encoding($false)))` — `Set-Content -Encoding utf8` emits a BOM and
silently reset the VPS to defaults on 2026-08-02.

---

## 4. The weekend cycle

Runs on the VPS (always-on); reports cover both boxes.

| When | Stage | Output |
|---|---|---|
| **Sat 08:00** | Evidence gathering — score the shadow log, run walk-forward sweeps, compute calibration, summarise the week's closed trades | new `ledger.jsonl` rows |
| **Sat 12:00** | Challenger session — agents propose changes, each with pre-declared criteria | `challengers/` entries |
| **Sat 16:00** | Court — adversarial review, cross-examination, verdicts | `verdicts.jsonl` |
| **Sun 09:00** | Apply promoted changes to **both** boxes, verify parity, commit | updated `champion.json` |
| **Sun 10:00** | Report — what changed, why, on what evidence, and **what is still unmeasured** | weekend report |

The last column of the Sunday report matters most. A week where nothing had enough
evidence to promote is a *successful* week that must be reported as such — otherwise the
cycle degenerates into changing something to look productive.

---

## 5. Phases

### Phase 0 — restore sight (prerequisite)
- [ ] Scorer for `tasks/rr_rejected.jsonl` — walk candles forward per row, record whether
      target or stop came first. **Use `sourceSymbol`, never `ticker`** (GC=F vs XAUUSD
      were ~60 apart when the first rows were written).
- [ ] Allowlist `/api/stats/by-setup` in `API_NO_LOGIN_GET_ONLY` (`index.js:194`) so
      calibration is measurable at all.
- [ ] Fix `mcp_server.js:324` — reads `learning?.setups`, but `/api/learning` returns
      `setupStats`, so `analyze_symbol` win rate is permanently null.
- [ ] Extend the walk-forward harness to sweep `MIN_RR`, `minStrength`, `adxTrendingMin`.
- [ ] Port today's four VPS fixes to local (still has the hardcoded 60, the refresh race,
      and gate 50).

**Acceptance:** every row in §3.5 reads "available", and a calibration table can be
produced on demand for both boxes.

### Phase 1 — ledger and registry
- [ ] `evidence/ledger.jsonl`, append-only, with a writer that refuses to edit rows
- [ ] `evidence/champion.json` seeded from current live config on both boxes
- [ ] Backfill known evidence: the 5/5 fold result for gate 70, the PF 0.91 result for
      band 65-69, the negative-expectancy decision of 2026-07-28

**Acceptance:** `why <parameter>` returns value, verdict, evidence and per-box sync state.

### Phase 2 — the court
- [ ] Challenger format with pre-declared criteria; registration rejects a challenger
      whose criteria are declared after its measurement
- [ ] Deterministic judge implementing §3.4 rules 1-3
- [ ] Cross-examination pass using `code-reviewer` / `analyst`
- [ ] `evidence/verdicts.jsonl`

**Acceptance:** a challenger with insufficient samples returns `INSUFFICIENT EVIDENCE`,
not a pass — verified with a deliberately underpowered test case.

### Phase 3 — weekend automation
- [ ] Scheduled tasks for the five §4 stages on the VPS
- [ ] Weekend report including the "still unmeasured" section
- [ ] Wire `/weekly` to read verdicts rather than re-deriving opinions

**Acceptance:** one full weekend runs unattended and produces a report a stranger could
audit.

### Phase 4 — parity
- [ ] Parity checker: live config on both boxes vs `champion.json`
- [ ] Alert on divergence through the existing Telegram path (note: **outbound sending
      works; inbound polling is dead** because a Supabase webhook owns the bot)
- [ ] Promotion applies to both boxes or neither, and says which

**Acceptance:** deliberately setting the laptop's gate to a different value raises an
alert within one cycle.

---

## 6. The honest weakness

**Sample size is the binding constraint, and no amount of process manufactures it.**

The system has 2 lifetime trades — one closed at −$449.72, one open. The learning engine
needs 5 closed trades per setup before it may draw a conclusion. At the current signal
rate that is months away, and the confidence gate is the wrong lever to accelerate it:
every trade admitted below 70 is measured-negative, so buying volume that way costs real
money to learn something the walk-forward already established.

Three legitimate routes, in preference order:

1. **Shadow evidence** — score trades the system *declined*. Free, unlimited, already
   started with the R:R log. Weaker than live evidence (no slippage, no fills) and must
   be labelled as such in the ledger.
2. **Wider backtests** — extend the harness across more history and more parameters.
   Cheap, but in-sample overfitting is the standing risk; out-of-sample folds are the
   control.
3. **Accept the horizon** — run at the measured-best config and let live evidence
   accumulate over months.

A professional plan names its own weakest assumption. This is ours: **for the first
several weeks the court will mostly return `INSUFFICIENT EVIDENCE`, and that verdict must
be treated as success.** The failure mode to guard against is loosening a gate so that
something — anything — happens.

---

## 7. What "done" looks like

- Any parameter's value can be traced to a verdict, its evidence, and its date
- Both boxes provably run the same config, or the divergence is alarmed
- The weekend cycle runs unattended and reports what it could *not* measure
- A proposal cannot be filed three days running with nobody noticing
- A dead execution path cannot sit green for 11 days
