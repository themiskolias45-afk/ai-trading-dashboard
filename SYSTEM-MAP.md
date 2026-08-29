# JARVIS × SmartEntry Pro — System Architecture Map
*Audited 2026-08-29 | 445 files scanned | Overall: 51% complete*

Read this when you want to know where the system stands, what is missing, and what to build next.
It is a living document — update it whenever a stage moves.

---

## Five-Stage Build Plan

| Stage | Name | Complete | Status |
|-------|------|----------|--------|
| S–01 | Foundations — Identity, Memory & Safety | 80% | Active, mostly done |
| S–02 | Automation — 24/7 Self-Healing Cycle | 60% | Active, key gaps |
| S–03 | Real World System — Live Trading, Fleet & Evidence | 75% | Active, key gaps |
| S–04 | RAG System — Semantic Memory & Knowledge Retrieval | 0% | Not started — biggest gap |
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
- No verification that scheduled tasks actually ran — a failed task looks like a quiet night
- No continuous signal alert daemon — push notifications require an open session
- No automated calibration drift detection — only found when human runs /daily
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

**Missing:**
- Economic calendar auto-context — upcoming NFP/FOMC/CPI not injected into analysis
- Autonomous pipeline — discover → backtest → implement still requires human trigger
- position_partial_taken not persisted — in-memory only, lost on bridge restart
- No CI/CD for VPS deploy — manual 7-patch process documented; prone to divergence

---

## Stage 04 — RAG System (0%) — BIGGEST GAP
*Semantic memory, vector search, knowledge retrieval over own history.*

**Nothing built yet.** Confirmed by full grep: zero results for vector, embedding, semantic, rag,
chromadb, pinecone, weaviate across all 445 project files.

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

**Missing:**
- No agent-to-agent messaging — handoff is parent reads text, no direct protocol
- Agents are stateless — continuity depends entirely on memory MCP being correct
- No 24/7 monitoring agent — all monitoring is human-triggered and periodic
- No kill-switch — stopping /profit mid-run requires manual intervention
- No CI/CD — VPS deploy is manual patching
- No fully autonomous end-to-end pipeline — discover → implement needs human at trigger

---

## 10 Upgrades That Make JARVIS a Real Big Brain
*Ranked by impact on intelligence, autonomy, and learning speed.*

| Rank | Upgrade | Stage | Impact |
|------|---------|-------|--------|
| 01 | **RAG / Semantic Memory** — ChromaDB + local embeddings over all trades/lessons/vault | S–04 | CRITICAL |
| 02 | **Autonomous Pipeline** — /discover --implement auto-triggered when score ≥ 12, LOW risk | S–03/05 | CRITICAL |
| 03 | **Continuous Signal Alert Daemon** — 24/7 push notifications, no open session required | S–02 | HIGH |
| 04 | **Agent Memory Sharing** — shared context file within session; analyst writes, builder reads | S–05 | HIGH |
| 05 | **Calibration Drift Auto-Alert** — nightly comparison, alerts via send_alert without /daily | S–02 | HIGH |
| 06 | **Economic Calendar Auto-Context** — NFP/FOMC/CPI injected into every signal analysis | S–03 | HIGH |
| 07 | **Memory Schema Enforcement** — structured entity types prevent silent recall failures | S–01 | HIGH |
| 08 | **CI/CD for VPS Deploy** — git pull + parity check automated; one command ships both boxes | S–03/05 | MEDIUM |
| 09 | **Position Partial Memory Persistence** — persist partial_taken to JSON, survives restart | S–03 | MEDIUM |
| 10 | **/halt Kill-Switch** — stops all active agents and automation in one command | S–01/05 | MEDIUM |

---

## How to Use This Map

- **Before starting a session**: scan the pipeline bar (S01–S05 percentages) to know where you are.
- **When choosing what to build**: pick the lowest-ranked upgrade above (highest impact, not yet done).
- **After completing a stage item**: update the percentage and move the item from Missing → Built.
- **Do not prioritise S–05 complexity over S–04 RAG** — a smarter memory layer multiplies the value of everything else.

*Update this file via the living artifact at claude.ai/code/artifact/e2749163-4bbc-4fac-830d-8c93f892e6d1*
