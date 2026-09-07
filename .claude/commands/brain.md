Pull the full intelligence picture: evidence board + brain status. Usage: /brain

═══ STEP 1 — GATHER ═══
  In parallel:
  mcp__smartentry__get_evidence_board  → curated claims with status, evidence, falsifiers
  mcp__smartentry__get_brain_status    → time, fleet verdict, signals, risk, AI employee, zone proximity
  mcp__smartentry__get_rejection_evidence → live per-gate verdict (EARNING/COSTING/TOO FEW)

═══ STEP 2 — FORMAT BY CLAIM STATUS ═══
  Group evidence board claims into four buckets — most actionable first:

  [ACTIONABLE NOW]
  Claims with status CANDIDATE — NEEDS WALK-FORWARD and measuredOn > 30 days ago:
    → Read liveSample.closedFills from the board payload.
    → If the claim carries sampleAtWriting.closedFills:
        newFills = liveSample.closedFills − claim.sampleAtWriting.closedFills
        If newFills < 5: show "[id]: [title] — only [N] new fills since measured — re-running adds little"
          Do NOT present as urgently actionable.
        If newFills ≥ 5: show "[id]: [title] | last measured [date] | trigger: [whatWouldChangeThis]"
          → "Run /backtest to settle. Enough sample? Check get_performance trade count."
    → If claim has no sampleAtWriting: use date-only check as before.

  [CONTRADICTED]
  Claims with status CONTRADICTED — TWO SOURCES DISAGREE:
    → "[id]: [title] | [evidence summary] | [caveat]"
    → "These need a tiebreaker measurement. Do not act on either source until resolved."

  [MEASURED — settled, no action needed]
  ROBUST and MEASURED_NO_EDGE claims (for awareness):
    → "[id]: [title] | [status] | measured [date]"

  [BLOCKED / UNMEASURED]
  Claims waiting on data or infrastructure:
    → "[id]: [title] | [whatWouldChangeThis]"

═══ STEP 3 — BRAIN STATUS SUMMARY ═══
  From get_brain_status summary.trading.signals — for each asset:

  SIGNALS with h1Agree (B2):
    If setup contains "MOMENTUM", read h1Agree from the signal object:
      h1Agree === false → append "h1: AGAINST (replay: 16% WR / -0.599R, 5/5 neg folds)"
      h1Agree === true  → append "h1: WITH (+0.634R/trade, 5/5 pos folds)"
      h1Agree === null  → omit (non-MOMENTUM setup or field absent)

  ZONE PROXIMITY (B1):
    If signal.zoneProximity is present and not null:
      If priceInside: "PRICE IN x[N] ZONE [low]–[high] — direction of break matters (feedsTheGate:false)"
      If nearestAbove (BUY signal): "Resistance x[N] [distanceAtr] ATR above ([methods])"
      If nearestBelow (SELL signal): "Support x[N] [distanceAtr] ATR below ([methods])"
    If zoneProximity is null (market-context unavailable): omit zone lines silently.

  From get_brain_status:
  - Time: [local + UTC + session timing]
  - Fleet: [verdict — AGREE / DIVERGES / PEER UNREACHABLE]
  - Risk: [halted/open, consecutive losses, regime]
  - AI Employee: [unreviewed proposals count]

  From get_rejection_evidence:
  - Gates COSTING MONEY: [list with net R]
  - Gates EARNING ITS KEEP: [list]
  - Gates TOO FEW TO JUDGE: [list — note sample needed]

═══ REPORT FORMAT ═══
BRAIN STATUS — [date] [time]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ACTIONABLE CANDIDATES:
  [id] [title] — [N] days since last measurement ([M] new fills)
  → Run: /backtest [relevant asset or threshold]

CONTRADICTED CLAIMS:
  [id] [title] — sources disagree
  → Needs: [tiebreaker measurement]

FLEET: [verdict]
SIGNALS: BTC [X]% (gap [G]pt) | GOLD [X]% | SPX [X]%
  BTC  BUY 84% MOMENTUM h1: AGAINST — Resistance x5 0.3 ATR above  ← example line
  GOLD BUY 76% SQUEEZE  h1: WITH    — Support x4 0.5 ATR below
RISK: [halted/open] | [N] consecutive losses | regime [X]
AI WORK: [N] unreviewed proposals

GATES COSTING MONEY:   [gate] net [R]R over [N] episodes
GATES EARNING KEEP:    [gate] net [R]R — leave alone
TOO FEW TO JUDGE:      [gate] [N] resolved (need ≥5)

SETTLED CLAIMS (no action):
  [id] [status] — [title]

BLOCKED:
  [id] — waiting for [condition]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After report:
  If ACTIONABLE CANDIDATES exist (newFills ≥ 5): "Run /backtest to settle [id]? (Y/N)"
  If AI Employee has unreviewed proposals: "Review proposals? Type /agent to process them."
  If COSTING MONEY gate found: "Investigate [gate]? Run /diagnose for full trace."
