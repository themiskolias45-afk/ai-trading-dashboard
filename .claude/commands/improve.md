Find and implement the single best improvement to SmartEntry Pro right now.
Uses live performance data + web research + code analysis.

STEP 1 — Gather data in parallel (use MCP tools directly):
  mcp__smartentry__get_performance          → total WR, P&L, best/worst setup
  mcp__smartentry__get_learning             → setup win rates, boosts, calibration
  mcp__smartentry__get_journal limit=50     → last 50 trades (which setups failed)
  mcp__smartentry__get_signals              → current signal quality per asset
  mcp__smartentry__read_memory query="improvement recent" → any prior improvement notes

  Also run SIGNAL-DEAD check:
    Find last trade date per asset. If any asset > 7 days without signal → flag SIGNAL-DEAD.
    SIGNAL-DEAD is always the #1 priority — a system that doesn't fire earns nothing.

STEP 2 — Web research (parallel, targeted at the weakest area found in Step 1):
  Brave search: "best algorithmic trading signal improvement 2025 [WEAKEST_SETUP]"
  Brave search: "quantitative trading confidence calibration [ASSET]"

STEP 3 — Synthesize: which problem costs the most money right now?
  Weaknesses to check (in priority order):
  1. SIGNAL-DEAD: asset hasn't fired in > 7 days (top priority — zero trades = zero profit)
  2. Setup WR < 45% over ≥ 5 trades → cut or tune
  3. Confidence tier mismatch (65-74% tier with < 50% actual WR) → calibration drift
  4. Asset consistently underperforming others
  5. Fear & Greed extreme not being used (stale sentiment)
  6. Missing volume/spread filter that research shows improves R:R

Report:

IMPROVEMENT ANALYSIS — [date]
---
SIGNAL STATUS: BTC [N days, DEAD/OK] | GOLD [N days] | SPX [N days]
WEAKEST SETUP: [name — WR%, trade count]
CALIBRATION: [which tier is off and by how much]
RESEARCH INSIGHT: [one finding from web that's directly applicable]

BEST FIX NOW:
  WHAT: [one clear problem]
  WHY:  [root cause, specific]
  EVIDENCE: [data point or research finding]
  FIX:  [exact change — parameter, threshold, or code line]
  IMPACT: [estimated WR improvement or risk reduction]
  RISK: [what could break]

Ask: "Implement this fix? (Y/N)"

If yes AND the fix touches server/index.js or any trading logic:
  - Write the CHANGING/NOW/AFTER/RISK scaffold first (mandatory)
  - If RISK touches signal generation, risk gate, lot sizing, or stop logic → STOP and show user
  - Spawn the builder agent with subagent_type: "builder":
      TASK: [exact fix]
      YOUR FILES: [exact files]
      INTERFACE CONTRACT: [what functions/routes must stay compatible]
      VERIFY COMMAND: node --check server/index.js
  - After builder reports DONE: run code-reviewer agent on changed functions
  - Fix all CRITICAL findings before proceeding
  - mcp__smartentry__write_memory key="last-improvement" value="[what changed and why]"

If yes AND the fix is config-only (threshold, constant, no logic change):
  - Read the FULL function before touching anything
  - Make the minimal change only
  - Run: node --check server/index.js
  - Commit the change
  - mcp__smartentry__write_memory key="last-improvement" value="[what changed and why]"
