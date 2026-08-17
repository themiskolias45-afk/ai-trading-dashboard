# Engineer plan — 2026-08-17

Two workstreams. Both are **observability only**: no gate, threshold, confidence, sizing,
stop or signal logic changes, and `feedsTheGate` stays false throughout. Neither trips the
skill's approval gate.

## Scope check

- 2 independent components, **zero file overlap** → parallel is warranted.
- Neither touches signal generation, the risk gate, or lot sizing.
- B edits `server/index.js`, so the **code-reviewer agent runs on it** before ship
  (skill rule + CLAUDE.md). A does not touch that file.

## File ownership — no overlap

| workstream | owns exclusively |
|---|---|
| **A — deferred status** | `tasks/ai_decide.cjs`, `server/ai_work_ledger.js`, `tasks/ai_brief.cjs` |
| **B — fleet bar freshness** | `server/index.js`, `dashboard/plan.html` |

Neither may touch the other's files. Neither may touch `server/journal.json`,
`server/learning.json`, or any ledger under `tasks/`.

## Interface contract — A

`tasks/ai_decide.cjs`
- `VALID` becomes `["implemented", "rejected", "ignored", "deferred"]`.
- Row shape is **unchanged** (`{id, status, note, call, job, file, line, decidedAt}`);
  `status` simply gains a legal value. Append-only, last line wins — unchanged.

`server/ai_work_ledger.js`
- A `deferred` decision **counts as decided** for `status` (the proposal is no longer
  `UNREVIEWED`) but **must NOT satisfy** the OUTPUT IGNORED verdict at line 443 — a
  deferred proposal is still owed work, and treating it as closed would recreate the exact
  blindness that verdict exists to catch.
- `totals` gains `deferred: <count>`. Existing keys keep their meaning:
  `reviewed` (line 490) must continue to mean "has any decision".
- **HARD CONSTRAINT:** `proposalId()` (line ~186, keyed `job|file|line|text.slice(0,80)`)
  must not change. Its own comment states that changing it orphans every decision in
  `tasks/ai_decisions.jsonl`. Prove all existing ids survive.

`tasks/ai_brief.cjs`
- Section 3 wording explains `deferred` to agents: right, accepted, not yet applied —
  and that it is still open work, not a closed matter.

## Interface contract — B

`server/index.js` — `/api/system-plan` (route at line 6326) gains, on **both**
`thisBox` and `peer`:

```js
barFreshness: {
  checked: Boolean,        // false when no asset reported a checked series
  staleAssets: String[],   // e.g. ["gold"] — asset keys whose MT5 series is stale
  worst: null | {          // the single worst asset, or null when none is checked
    asset: String, stale: Boolean, ageMs: Number|null,
    lastBarAt: String|null, reason: String, usedForThisSignal: Boolean
  }
}
```

Source: each box's **public** `/api/signals` (it is in `API_NO_LOGIN_REQUIRED`), reading
the `barFreshness` object already stamped per asset. "Worst" = stale first, then greatest
`ageMs`. Unreachable peer or missing field → `checked: false`, `worst: null`, never a
fabricated date.

`dashboard/plan.html` — `renderFleet()` (line 317) shows it per box in the page's existing
row language.

**Copy constraint:** `stale: true` means the **MT5 series** is stale. The engine has
already fallen back to Yahoo, so the prices shown are fresh and it is the broker feed that
is not. The wording must not imply bad prices.

## Deployment — both boxes, always

Laptop `C:\Users\User\ai-trading-dashboard`; Contabo VPS `169.58.74.133`
`C:\ai-trading-dashboard`, key `C:\Users\User\.ssh\contabo_smartentry`, ssh needs
`-i KEY -o BatchMode=yes`.

**`server/index.js` is PATCHED on the VPS via `git apply`, never copied** — it carries
commits this repo has never seen. Everything else goes by `scp`. Back up before overwrite.
Nothing is deleted. Integration and deployment are the architect's job, not the builders'.

## Note on tracking

`TaskCreate` is not exposed in this session, so the workstreams are tracked here and in the
final report rather than as harness tasks. Recorded rather than silently skipped — a
"TASKS CREATED: 2" line nobody can verify is exactly the decoration this project keeps
removing.
