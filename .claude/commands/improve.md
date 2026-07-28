Find and implement the single best improvement to SmartEntry Pro right now.
Uses live performance data + web research + code analysis.

STEP 1 — Gather data in parallel (use MCP tools directly):
  mcp__smartentry__get_performance          → total WR, P&L, best/worst setup
  mcp__smartentry__get_learning             → setup win rates, boosts, calibration
  mcp__smartentry__get_journal limit=50     → last 50 trades (which setups failed)
  mcp__smartentry__get_signals              → current signal quality per asset
  mcp__smartentry__read_memory query="improvement recent" → any prior improvement notes

STEP 2 — Web research (parallel, targeted at the weakest area found in Step 1):
  Brave search: "best algorithmic trading signal improvement 2025 [WEAKEST_SETUP]"
  Brave search: "quantitative trading confidence calibration [ASSET]"

STEP 3 — Synthesize: which problem costs the most money right now?
  Weaknesses to check:
  - Setup WR < 45% over ≥ 5 trades → cut or tune
  - Confidence tier mismatch (65-74% tier with < 50% actual WR) → calibration drift
  - Asset consistently underperforming others
  - Fear & Greed extreme not being used (stale sentiment)
  - Missing volume/spread filter that research shows improves R:R

Report:

IMPROVEMENT ANALYSIS — [date]
---
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
If yes:
  - Read the FULL function in server/index.js before touching anything
  - Implement minimal change only
  - Run: node --check server/index.js
  - Commit the change
  - mcp__smartentry__write_memory key="last-improvement" value="[what changed and why]"
If fix touches live signal logic, show the diff and wait for explicit approval.
