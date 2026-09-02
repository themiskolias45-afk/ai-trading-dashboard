# JARVIS × SmartEntry Pro — System Architecture Map
*Audited 2026-08-29 | 445 files scanned | Overall: 51% complete*
*RE-AUDITED 2026-09-02: SEVEN claims below were FALSE — built, but still listed as
missing, including the #1 CRITICAL item. Corrections are marked `CORRECTED 2026-09-02`
with the file that disproves them. **Verify a Missing item still is missing before
building it** — this map is read at boot to decide what to build next, and "duplicate"
appears in 67 commit messages here.*

Read this when you want to know where the system stands, what is missing, and what to build next.
It is a living document — update it whenever a stage moves.

---

## Five-Stage Build Plan

| Stage | Name | Complete | Status |
|-------|------|----------|--------|
| S–01 | Foundations — Identity, Memory & Safety | 80% | Active, mostly done |
| S–02 | Automation — 24/7 Self-Healing Cycle | 60% | Active, key gaps |
| S–03 | Real World System — Live Trading, Fleet & Evidence | 75% | Active, key gaps |
| S–04 | RAG System — Semantic Memory & Knowledge Retrieval | ~80% | **BUILT — corrected 2026-09-02** |
| S–05 | Multi Agents — Swarm, Employees & Continuous Improvement | 40% | Partially started |

---

## Stage 01 — Foundations (80%)
*Identity, persistent memory, safety rules, hooks, evidence tracking.*

**Built:**
- JARVIS identity in CLAUDE.md — same name/personality every session
- Dual-layer memory: MCP graph + smartentry key-value store
- 7-step boot sequence with full state recovery
- 9 standing rules — enforced per-session
- Pre-flight checklist (6 questions) before every code edit
- Hook system: pre-edit, post-edit, git-safety, session-stop
- Evidence register — curated claims with status and falsifiers
- Tools manifest — every MCP tool risk-tagged (read/write/TRADES)
- **Decision register** (2026-09-02) — `tasks/decisions.cjs`. 38 standing decisions were
  living ONLY inside source comments, where nothing indexed them, so "has this already
  been decided?" was unanswerable unless you knew the filename. An agent overrode a
  locked decision twice in one afternoon for exactly that reason. Harvest / check /
  **guard** / add / export, append-only, keyed on decision TEXT so a shifted file updates
  its address instead of forking. Wired into the pre-edit hook (never blocks) and
  harvested nightly before the brief is rebuilt.

**Partial / Weak:**
- Memory schema is freeform — entity types inconsistently labelled, degrades recall over time
- /memory prune is manual — graph grows without bound between prune calls
- Vault path (C:\Users\…) is Windows-specific — fails silently in Linux/remote sessions

---

## Stage 02 — Automation (60%)
*Everything that runs without a human: watchdogs, nightly pipelines, scheduled reviews.*

**Built:**
- Auto-healer — polls server health every 30s, auto-recovers stale data
- ensure_running.ps1 — server watchdog every 10 min + logon trigger
- auto_daily.bat — nightly rejection ledger pipeline (score → shadow stats)
- auto_runner.py — daily health + performance + web research + AI proposal (once/day)
- eod_review.py — end-of-day P&L + insight, 22:00 UTC automatically
- /auto command — overnight brief + self-heal, schedulable via Task Scheduler
- VPS: 12 scheduled tasks including strategy search — runs while laptop sleeps

**Missing:**
- ~~No verification that scheduled tasks actually ran~~ — **CORRECTED 2026-09-02:** built.
  `tasks/autonomy_audit.ps1`, `tasks/coverage_audit.ps1` and `tasks/doctor.cjs` all read
  `LastTaskResult`. (Still true that a task can return 0 having written nothing — that
  bit the VPS on 2026-09-02 with a bare `node.exe`; verify by LOG GROWTH, not exit code.)
- ~~No continuous signal alert daemon~~ — **CORRECTED 2026-09-02:** six run on schedule —
  Band Monitor, Plan Monitor, MACD Cross Monitor, and the CRT/FVG/TK shadow runners.
- ~~No automated calibration drift detection~~ — **CORRECTED 2026-09-02:**
  `tasks/calibration_drift_alert.py` runs nightly in `auto_daily.bat` and notifies
  through `notifications.py`.
- /learn and /state save are manual — no enforced session-end hook

---

## Stage 03 — Real World System (75%)
*Live trading, fleet parity, rejection ledger, walk-forward validation, strategy research.*

The binding constraint is sample size (~5 trades/19 days live). Time is the only fix — every change
that slows accumulation costs more than it saves.

**Built:**
- MT5 bridge — live execution, both accounts, tagged per machine
- Fleet (2 boxes) — vps_parity.cjs verifies engine agreement after every deploy
- Live signals — BTC / GOLD / SPX multi-timeframe confidence scoring
- Rejection ledger — every gate rejection scored as a paper trade, nightly
- Walk-forward harness — 5-fold OOS, worst-fold comparison, ~90s
- Circuit breaker — halts on consecutive losses, manual or timed reset
- safe_bridge_restart.cjs — refuses restart if open positions lack SL
- Strategy search — automated nightly on VPS, findings surface at boot
- **Three live strategy models** (2026-09-02) — CRT+FVG, FVG continuation, TK swing
  pullback. Own runner, own magic number, own append-only ledger, `MaxOpen 1`, armed on
  both boxes. They enter the retest the engine declines by construction and share none
  of its code. `tasks/fvg_executor.py` reads sizing from `strategy_settings.json` and
  fails CLOSED on either halt system.

**Missing:**
- Economic calendar auto-context — upcoming NFP/FOMC/CPI not injected into analysis
- Autonomous pipeline — discover → backtest → implement still requires human trigger
- ~~position_partial_taken not persisted~~ — **CORRECTED 2026-09-02:** it is persisted,
  `mt5_bridge.py:231` — "Persists position_partial_taken across restarts".
- No CI/CD for VPS deploy — manual 7-patch process documented; prone to divergence

---

## Stage 04 — RAG System (~80%) — BUILT, corrected 2026-09-02
*Semantic memory, vector search, knowledge retrieval over own history.*

**THIS PARAGRAPH WAS FALSE AND SAID SO CONFIDENTLY.** It claimed a full grep found zero
results for chromadb/embedding/semantic across 445 files. Re-run 2026-09-02: it matches
`tasks/rag_index.py`, `tasks/rag_query.py`, `tasks/rag_recall.py` and more. The system was
used to answer real questions the same day. A confident negative from a grep that was
never re-run is the same failure shape this project keeps finding — "Graph OK" over an
empty store, a STALE banner that could not fire, a harvester blind to CRLF files.

**Built:**
- ChromaDB vector store at `tasks/rag_db/`, local, nothing leaves the machine
- `all-MiniLM-L6-v2` embeddings, `tasks/rag_index.py`
- SIX sources: trades, shadow/lessons, memory, brain (337 memory files), vault, and
  **decisions** (added 2026-09-02)
- `tasks/rag_query.py` — semantic search, source filtering, standing decisions surfaced
  first and never cut by top_k
- Chunking pipeline with deferred delete, so a killed rebuild cannot empty the index
- Nightly re-embed wired into `auto_daily.bat`

**Still missing:**
- Context injection at boot is MANUAL — `rag_query.py` must be called; nothing surfaces
  top-K memories automatically at session start
- No semantic edges in the MCP knowledge graph — that layer is still keyword-only

As memory accumulates, keyword search degrades — common terms return too many hits, specific lessons
are missed. The CLAUDE.md boot itself documents a case where the five-word query silently returned
zero results for months. Semantic search fixes this permanently.

**What needs to be built:**
- Vector database — ChromaDB (local, no cloud dependency) or equivalent
- Embedding model — index trades, lessons, vault notes, strategy research
- Semantic search — "has Gold done this before?" answered with real evidence
- Document chunking pipeline — vault notes, journal, rejection log
- Context injection — top-K relevant memories surfaced automatically at boot
- Knowledge graph with semantic edges — beyond keyword-only MCP memory

---

## Stage 05 — Multi Agents (40%)
*Parallel engineers, AI employees, continuous improvement loop, CI/CD.*

**Built:**
- /engineer — 5 parallel builders, worktree isolation, pathspec commits
- 5 specialist agents: analyst, builder, researcher, tester, code-reviewer
- AI employee proposals — nightly research, unreviewed proposal queue
- /profit, /pipeline, /daily — chained multi-agent workflows
- MAX_AGENT_CALLS: 10 hard cap — prevents unbounded autonomous spend
- code-reviewer mandatory after every server/index.js edit
- **Agent operating boundary** (2026-09-02) — `tasks/AGENT-BOUNDARY.md`, appended to all
  six agent definitions: scope, the consent rule, the decisions check, the brief.
  `code-reviewer` now declares `tools: Read, Grep, Glob, Bash` — Write and Edit removed.
  Added after one ran 217 tool calls past a two-hunk review brief, deployed to the
  production VPS, and reported user approvals that had never been given.

**Missing:**
- No agent-to-agent messaging — handoff is parent reads text, no direct protocol
- ~~Agents are stateless / no shared context~~ — **PARTLY CORRECTED 2026-09-02:**
  `tasks/ai_brief.md` is a shared context file, rebuilt nightly before the daily agent
  runs, and now carries a Standing Decisions section. Agents still hold no state
  BETWEEN spawns, which is the part that remains true.
- No 24/7 monitoring agent — all monitoring is human-triggered and periodic
- ~~No kill-switch~~ — **PARTLY CORRECTED 2026-09-02:** `.claude/commands/halt.md`
  exists and the dashboard writes `/api/mt5/control`. **But measured the same day, that
  switch reached 2 of 5 order paths** — the bridges read it, the three model executors
  read `/api/risk-status` instead. Fixed in `75bda76`; any NEW order path must check
  both and fail closed on either.
- No CI/CD — VPS deploy is manual patching
- No fully autonomous end-to-end pipeline — discover → implement needs human at trigger

---

## 10 Upgrades That Make JARVIS a Real Big Brain
*Ranked by impact on intelligence, autonomy, and learning speed.*

| Rank | Upgrade | Stage | Impact |
|------|---------|-------|--------|
| ~~01~~ | ~~**RAG / Semantic Memory**~~ — **DONE.** ChromaDB + MiniLM, 6 sources. Only boot-time auto-injection remains | S–04 | ~~CRITICAL~~ |
| 02 | **Autonomous Pipeline** — /discover --implement auto-triggered when score ≥ 12, LOW risk | S–03/05 | CRITICAL |
| ~~03~~ | ~~**Continuous Signal Alert Daemon**~~ — **DONE.** Six scheduled monitors; Band, Plan, MACD Cross, CRT/FVG/TK runners | S–02 | ~~HIGH~~ |
| 04 | **Agent Memory Sharing** — PARTLY DONE: `tasks/ai_brief.md` is shared and nightly. Agents still hold no state BETWEEN spawns | S–05 | HIGH |
| ~~05~~ | ~~**Calibration Drift Auto-Alert**~~ — **DONE.** `tasks/calibration_drift_alert.py`, nightly in auto_daily.bat | S–02 | ~~HIGH~~ |
| 06 | **Economic Calendar Auto-Context** — NFP/FOMC/CPI injected into every signal analysis | S–03 | HIGH |
| 07 | **Memory Schema Enforcement** — structured entity types prevent silent recall failures | S–01 | HIGH |
| 08 | **CI/CD for VPS Deploy** — git pull + parity check automated; one command ships both boxes | S–03/05 | MEDIUM |
| ~~09~~ | ~~**Position Partial Memory Persistence**~~ — **DONE.** `mt5_bridge.py:231` persists across restarts | S–03 | ~~MEDIUM~~ |
| 10 | **/halt Kill-Switch** — PARTLY DONE: `.claude/commands/halt.md` + dashboard control. It reached 2 of 5 order paths until `75bda76` | S–01/05 | MEDIUM |

---

## How to Use This Map

- **Before starting a session**: scan the pipeline bar (S01–S05 percentages) to know where you are.
- **When choosing what to build**: pick the lowest-ranked upgrade above (highest impact, not yet done).
- **After completing a stage item**: update the percentage and move the item from Missing → Built.
- **Do not prioritise S–05 complexity over S–04 RAG** — a smarter memory layer multiplies the value of everything else.

*Update this file via the living artifact at claude.ai/code/artifact/e2749163-4bbc-4fac-830d-8c93f892e6d1*
