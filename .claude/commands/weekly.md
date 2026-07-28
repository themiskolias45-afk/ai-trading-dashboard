Deep weekly review — strategy research, code audit, performance analysis, improvement plan.
Run every Monday morning (or end of week). Takes 15-20 minutes — do it fully.

Usage: /weekly

═══════════════════════════════════════════════════════
ALL 8 STEPS REQUIRED — NO SKIPPING
═══════════════════════════════════════════════════════

STEP 1 — FULL PERFORMANCE ANALYSIS (all data, parallel):
  mcp__smartentry__get_journal limit=200    → all trades (not just recent)
  mcp__smartentry__get_performance          → aggregate stats
  mcp__smartentry__get_learning             → setup calibration + boosts
  mcp__smartentry__read_memory query="weekly improvement" → past week's lessons

  Calculate per setup (require ≥ 3 trades to judge):
  - Win rate this week vs last week vs all-time (is it trending?)
  - Average R:R achieved vs expected (if always worse than planned — entry timing issue)
  - Best and worst trade for each setup (look for patterns)
  - In which market regime does each setup perform best? (TRENDING vs RANGING)
  - Time of day / session for best performance

  Flag setups where performance THIS WEEK is > 10% worse than all-time average.

STEP 2 — CONFIDENCE CALIBRATION DEEP AUDIT:
  Group ALL trades by confidence tier:
    Tier 1: confidence 65-74%
    Tier 2: confidence 75-84%
    Tier 3: confidence 85%+

  For each tier: actual WR%, count, P&L
  Expected: Tier 1 ~65-70%, Tier 2 ~75%, Tier 3 ~85%

  Calibration health:
    WELL-CALIBRATED: actual within 10% of expected
    OVERCONFIDENT:   actual < expected by > 10% (system fires too often at wrong times)
    UNDERCONFIDENT:  actual > expected by > 10% (signals are stronger than scored — could scale)

  If OVERCONFIDENT: the confidence threshold may need to raise (e.g., require ≥ 70 not ≥ 65)
  If UNDERCONFIDENT: could lower threshold or increase position size

STEP 3 — CODE QUALITY AUDIT:
  Read server/index.js (full file, front to back).
  Look for and list every instance of:
    - Empty catch blocks: } catch (e) { } — silent failure, untraceable bugs
    - Missing await on async calls (potential race conditions)
    - Unbounded array growth (push without cleanup — memory leak)
    - setInterval/setTimeout with no clearInterval (leak if called repeatedly)
    - Any hardcoded threshold that should be configurable (confidence 65, lot sizes)
    - Any route with no error handling on the HTTP response
    - Any JSON.parse without try/catch (crash on malformed data)

  Rate overall code health: A (no issues) / B (minor) / C (needs work) / D (critical issues)

STEP 4 — DEEP STRATEGY RESEARCH (parallel, targeted at current weaknesses):
  From Step 1, identify: what is the system's #1 performance gap?
    Gap A: Win rate below expected → search for better entry filters
    Gap B: R:R worse than planned → search for better exit techniques
    Gap C: Regime-dependent weakness → search for regime filtering strategies
    Gap D: Specific setup underperforming → search for that setup specifically

  Run in parallel:
    Brave search: "best [gap area] trading strategy BTC gold 2025 backtested"
    Brave search: "quantitative [gap area] improvement algorithmic trading 2025"
    Exa search:   "[gap area] trading strategy win rate academic research"
    Brave search: "professional trader [worst setup] filter technique"

  For each finding, score: CODEABLE (Y/N) + EDGE data (Y/N) + FIT for our assets (Y/N)
  Only include findings that score YES on all three.

STEP 5 — BACKTEST COMPARISON:
  If backtest data is available (GET /api/backtest):
    Compare live trading results vs backtest expectations:
    - Backtest WR vs live WR (if live is > 10% worse → implementation drift)
    - Backtest avg R:R vs live avg R:R
    - Backtest max drawdown vs live max drawdown

  Flag "BACKTEST DRIFT" if live performance is consistently below backtest.
  Causes of drift: slippage, news gaps, wrong execution timing, overfitted backtest

STEP 6 — COMPETITIVE ANALYSIS:
  Brave search: "best algorithmic trading system BTC gold 2025 win rate"
  Brave search: "top crypto trading bot performance 2025"

  Find: what win rates and R:R ratios are the best systems achieving?
  Compare to SmartEntry's live numbers.
  Identify: where is the gap and what's the most likely cause?

STEP 7 — WEEKLY IMPROVEMENT PLAN:
  Based on Steps 1-6, generate the plan for THIS WEEK.
  Maximum 5 action items, ranked by financial impact (highest first).

  Each action item:
  ACTION [N] — [MUST DO / SHOULD DO / NICE TO HAVE]
  ────────────────────────────────────────────────
  TARGET:   [what system component — setup name, function name, or config]
  PROBLEM:  [specific evidence — data point from this week's analysis]
  CHANGE:   [exact parameter or code change]
  EXPECTED: [+X% WR on [setup] / -$X drawdown / +X% calibration accuracy]
  EFFORT:   [Simple / Medium / Complex]
  COMMAND:  [/improve, /fix [what], /research [what], or /build [what]]

STEP 8 — CREATE TASKS + PERSIST:
  TaskCreate for every MUST DO action item.
  For SHOULD DO: create task if Simple or Medium effort.

  mcp__smartentry__log_note tag="WEEKLY-REVIEW" text="[top finding + top action for the week]"
  mcp__smartentry__write_memory key="weekly-[date]" value="[calibration status | worst setup | top action | code health grade]"
  mcp__memory__create_entities for any new lesson that should persist across sessions.

═══════════════════════════════════════════════════════

WEEKLY REPORT FORMAT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEEKLY REVIEW — [week of date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRADES:  X total | X% WR | $X P&L | expectancy $X/trade
TREND:   [improving / degrading / stable] vs last week

SETUPS:
  STRONG (keep & can scale): [list with WR]
  OK (monitor):               [list with WR]
  REVIEW (tune this week):    [list with issue]
  KILL (disable now):         [list with WR — no mercy]

CALIBRATION:
  65-74%: X% actual [GOOD / OVERCONFIDENT / UNDERCONFIDENT]
  75-84%: X% actual
  85%+:   X% actual

CODE HEALTH: [A/B/C/D] — [top issue if any]

RESEARCH FINDINGS:
  [1] [finding — source — codeable: Y/N — edge: Y/N — fit: Y/N]
  [2] ...

TOP PERFORMANCE GAP: [one sentence — most important thing to fix]

THIS WEEK'S PLAN:
  [1] MUST: [action — expected impact]
  [2] MUST: [action — expected impact]
  [3] SHOULD: [action — expected impact]

TASKS CREATED: [X]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After report: "Start with action #1? (Y/N)"
