Comprehensive daily automated cycle. Run every morning before trading.
Checks everything, finds errors, analyzes learning, researches improvements, creates tasks.

Usage: /daily

═══════════════════════════════════════════════════════
ALL STEPS REQUIRED — NO SKIPPING
═══════════════════════════════════════════════════════

STEP 1 — SYSTEM HEALTH (deep check, parallel):
  mcp__smartentry__get_healer               → 6-point check (flag any RED)
  mcp__smartentry__get_signals              → all 3 assets, confidence, freshness
  mcp__smartentry__get_risk_status          → regime, halted, consecutive losses, P&L
  node --check server/index.js              → syntax (FAIL = immediate fix required)
  node --check server/autohealer.js         → syntax
  git ls-files -- 'server/apikey.txt' 'keys.env'  → must return empty

  Flag anything that fails as ERROR-[severity]: CRITICAL / HIGH / LOW

  SIGNAL-DEAD CHECK (run immediately, per asset):
    mcp__smartentry__get_journal limit=200 → find last trade date per asset (BTC, GOLD, SPX)
    mcp__smartentry__get_signals → get current confidence per asset
    Calculate: days since last confidence ≥ 65% per asset.
    SIGNAL-DEAD = > 7 days without signal. Flag as CRITICAL.
    SIGNAL-SLOW = 4-7 days. Flag as HIGH.
    SIGNAL-OK = < 4 days. Log and continue.
    If SIGNAL-DEAD: check if daily.signal=WAIT AND h4.signal=WAIT — market flat?
    Or is confidence 40-64 (calibration borderline — near but not firing)?

STEP 2 — DEEP ERROR SEARCH:
  Read the LAST 200 lines of each log that exists:
    tasks\logs\server_log.txt
    tasks\logs\bridge_log.txt
    tasks\logs\error_log.txt
    tasks\logs\startup_log.txt

  Scan for: ERROR, WARN, TypeError, undefined is not, Cannot read, ECONNREFUSED,
            SyntaxError, 500, Uncaught, unhandledRejection, memory leak

  For each error pattern found:
    - Note: file, line context, frequency (how many times?)
    - Classify: INTERMITTENT (< 3 times) / RECURRING (3-10) / CONSTANT (> 10)
    - Classify risk: TRADING-IMPACT (affects signals/execution) / SYSTEM (server stability) / COSMETIC

  Also grep the source code for anti-patterns:
    - Empty catch blocks: } catch { }  or  } catch (e) { }
    - Unhandled promise: .then( without .catch(
    - Any console.log in trading logic (performance/leak risk)

STEP 3 — DEEP LEARNING ANALYSIS:
  mcp__smartentry__get_learning             → all setup stats
  mcp__smartentry__get_performance          → overall WR, P&L, best/worst setup
  mcp__smartentry__get_journal limit=50     → last 50 trades

  Analyze each setup with ≥ 3 trades:
    a) WIN RATE TREND: compare first half vs second half of trades — improving or degrading?
    b) CALIBRATION: does confidence tier match actual WR?
       65-74% conf → expect ~65-70% WR (flag if actual < 55% or > 80%)
       75-84% conf → expect ~75% WR
       85%+ conf   → expect ~85% WR
    c) STREAK RISK: any setup with 3+ consecutive losses recently?
    d) OVERDUE REVIEW: any setup with > 20 trades and WR < 50%?

  Classify each setup:
    STRONG:    WR ≥ 65% with ≥ 5 trades and calibrated — keep and can scale
    OK:        WR 55-64% — monitor, don't scale
    REVIEW:    WR 45-54% or calibration off — needs parameter check
    KILL:      WR < 45% with ≥ 5 trades — disable immediately
    LEARNING:  < 5 trades — do not judge yet

STEP 4 — PERFORMANCE DEEP DIVE:
  From the journal (last 50 trades):
  - Trades in last 24h: wins / losses / P&L
  - Overall streak (last 5 trades): W/L/W/L/L etc.
  - Worst trade this week: setup, asset, what went wrong?
  - Best trade this week: setup, asset, what worked?
  - Average holding time per winning vs losing trade
  - Which market regime had the best / worst trades?

STEP 5 — WEB RESEARCH (targeted at today's weakest area from Steps 2-4):
  Identify: what is the #1 problem or opportunity right now?
    → If worst setup is degrading: search "[setup name] trading strategy fix improvement 2025"
    → If calibration drift: search "trading confidence score calibration machine learning 2025"
    → If recurring error: search "Node.js [error type] fix trading system"
    → If good results: search "scale winning trading strategy [asset] techniques"

  Brave search × 2 parallel (targeted queries)
  Exa search × 1 (academic/quant angle)

STEP 6 — RANKED RECOMMENDATIONS:
  Generate exactly 3-5 recommendations, ranked by estimated financial impact.
  Each must have all 5 fields:

  RECOMMENDATION [N] — [CRITICAL/HIGH/MEDIUM] priority
  ───────────────────────────────────────────────────
  WHAT:    [specific problem or opportunity — one sentence]
  WHY:     [data evidence — cite the specific number from Steps 1-5]
  HOW:     [exact action: file\function\parameter or command to run]
  IMPACT:  [estimated $ or WR % improvement — be specific, not "could help"]
  EFFORT:  [Simple < 30min / Medium 30-90min / Complex > 90min]

  Only include recommendations where WHY has a concrete data point.
  No generic advice. No "consider monitoring X". Specific and implementable only.

STEP 7 — CREATE TASKS (for recommendations ranked HIGH or CRITICAL):
  For each HIGH/CRITICAL recommendation:
    TaskCreate with:
      title: [DAILY-{date}] [WHAT — short form]
      description: [full WHAT + WHY + HOW]
      status: pending

STEP 8 — PERSIST:
  mcp__smartentry__log_note tag="DAILY-CHECK" text="[one-line summary of top issue and recommendation]"
  mcp__smartentry__write_memory key="daily-[date]" value="[errors found: X | top rec: [WHAT] | setups: [STRONG/KILL summary]]"
  mcp__memory__create_entities (if any new pattern was learned today that matters for future sessions)

═══════════════════════════════════════════════════════

DAILY REPORT FORMAT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DAILY CHECK — [date] [time]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HEALTH:    [X/6 green] | Signals: [BTC/GOLD/SPX status] | Halted: [Y/N]
SIGNAL AGE: BTC [N days] [DEAD/SLOW/OK] | GOLD [N days] | SPX [N days]
ERRORS:    [X found — X TRADING-IMPACT, X SYSTEM, X COSMETIC]
CODE:      [CLEAN / ERRORS: list files]

SETUP STATUS:
  [STRONG]: [list]
  [REVIEW]:  [list with specific issue]
  [KILL]:    [list — disable immediately]
  [LEARNING]: [list]

CALIBRATION: [65-74%: X% actual | 75-84%: X% actual | 85+: X% actual]

LAST 24H: [X trades | X wins | $X P&L | streak: W/L pattern]

TOP RECOMMENDATIONS:
  [1] [CRITICAL/HIGH] [WHAT] — [WHY in one data point]
  [2] [HIGH] [WHAT] — [WHY]
  [3] [MEDIUM] [WHAT] — [WHY]

TASKS CREATED: [X]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After report: "Implement recommendation #1 now? (Y/N)"
