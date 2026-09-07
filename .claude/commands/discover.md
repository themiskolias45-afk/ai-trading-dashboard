Surface and evaluate the latest strategy search findings. Usage: /discover [--implement]

The strategy search already runs every day automatically (tasks/strategy_search_vps.bat on VPS,
tasks/strategy_search.cjs daily via Task Scheduler). This command reads what it found, enriches
it with a researcher agent, scores each candidate, and surfaces the best proposals.

WITHOUT --implement: research + score + report. No code changed.
WITH --implement:    research + score + spawn builder on the top-ranked candidate.

═══ STEP 1 — READ EXISTING FINDINGS ═══
  Read tasks/analysis/strategy-search-latest.txt  — the latest automated search result
  Read tasks/logs/strategy_search.txt             — last 20 lines (recent run status)
  Read tasks/analysis/discovery-log.jsonl         — prior decisions (skip silently if missing)
  mcp__smartentry__read_memory query="strategy discovery proposal"  → any prior proposals
  mcp__smartentry__get_performance                → current WR and P&L baseline

  DEDUPE CHECK: Before spawning researcher agents in Step 3, cross-reference each candidate
  against discovery-log.jsonl. If a candidate's description matches a prior entry with
  decision=REJECTED, skip it and note "already decided [date]: [reason]". Only research
  candidates not yet in the log.

  If strategy-search-latest.txt is missing or empty:
    "Strategy search has not run yet. Run: node tasks/strategy_search.cjs --axis ceiling"
    Stop here.

═══ STEP 2 — EXTRACT CANDIDATES ═══
  From the search file, extract all proposals with:
    - proposed parameter change OR new filter OR new signal condition
    - a score or WR estimate
    - source axis (ceiling / gate)

  If zero candidates: "Search ran but found no proposals above the scoring floor. Market may be
  in a regime where no axis improvement is measurable. Check again tomorrow."

═══ STEP 3 — ENRICH WITH RESEARCHER AGENT ═══
  For the top 2 candidates, spawn researcher agent in parallel:

  Agent type: researcher
  Prompt per candidate: "Research this SmartEntry Pro strategy candidate:
  CANDIDATE: [description from search file]
  CURRENT SYSTEM: BTC/GOLD/SPX multi-timeframe, confidence gate at 70%, ~5 trades/19 days live.
  Find: (1) academic or quantitative evidence for or against this type of filter,
  (2) any known failure mode in live markets vs backtest,
  (3) one-sentence implementation risk assessment.
  Be specific. Score applicability 1-5. Under 300 words."

═══ STEP 4 — SCORE EACH CANDIDATE ═══
  For each candidate, rate on 4 axes (1-5 each):
  A. EDGE EVIDENCE  — is there external proof it works?
  B. BACKTEST FIT   — does the search file show WR improvement on this asset?
  C. IMPL RISK      — how hard to implement without breaking live trades?
  D. SAMPLE SIZE    — is there enough data to trust the finding (≥ 10 episodes)?

  TOTAL = A + B + (6 - C) + D   (higher = better, max 20)
  Minimum to propose: total ≥ 12.

═══ STEP 5 — BACKTEST WINNER (if ≥1 candidate scores ≥ 12) ═══
  Call: mcp__smartentry__run_walkforward
  Note: this tests the CURRENT system, not the candidate. Compare current WR as baseline.
  The candidate must beat this baseline's WORST FOLD to earn implementation.

═══ STEP 6 — REPORT ═══
DISCOVER REPORT — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEARCH LAST RAN: [date from log]
CANDIDATES FOUND: [N]
BASELINE WR (walk-forward worst fold): [X]%

TOP CANDIDATES:
  [1] [description] | Score: [X]/20 | Worst-fold improvement: [+X%] | PROPOSE / REJECT
  [2] [description] | Score: [X]/20 | REJECT — [reason]

WINNER: [description] — [why it scores highest]
  Edge evidence:  [finding from researcher]
  Risk:           [LOW / MEDIUM / HIGH — one sentence]
  Implement as:   [exact parameter change or code location]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After report:
  If --implement flag was passed and winner score ≥ 12:
    → Spawn builder agent on the winning candidate. Show CHANGING/NOW/AFTER/RISK first.
    → builder reads the relevant file, implements, verifies, commits.
  Else:
    "Implement top candidate? Run: /discover --implement"

Persist findings regardless:
  mcp__smartentry__write_memory key="discover-[date]" value="[winner + score + decision]"
  mcp__smartentry__log_note tag="DISCOVER" text="[candidate + evidence + verdict]"
  mcp__memory__create_entities if any finding is a genuine new lesson.

  WRITE TO DEDUPE LOG: append each candidate's decision to tasks/analysis/discovery-log.jsonl:
  {"date":"[YYYY-MM-DD]","candidate":"[description]","score":[N],"decision":"PROPOSED|REJECTED","reason":"[one sentence]"}
