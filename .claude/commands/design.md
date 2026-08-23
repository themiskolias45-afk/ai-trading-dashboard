Design or redesign any visual component of SmartEntry Pro. Usage: /design [what to design]

$ARGUMENTS: the component or page to design. If empty, ask: "What do you want to design?"

This command is for visual work — dashboard pages, signal cards, charts, performance views,
standalone HTML artifacts. It enforces design quality gates that /build skips for non-UI work.

═══ STEP 1 — IDENTIFY SCOPE ═══
  What type of design work?
  A) Dashboard page (dashboard/*.html)
  B) Signal/trade card component (embedded in existing page)
  C) Standalone artifact (performance report, daily brief, trade summary — publishable HTML)
  D) Chart / data visualisation (confidence gauge, P&L curve, win rate bar)

  For A/B: read the existing page FULLY before touching anything.
  For C: load artifact-design skill — calibrates the design investment level.
  For D: load dataviz skill — chart type, color formula, mark specs, interaction rules.

═══ STEP 2 — DESIGN SYSTEM (SmartEntry Pro standards) ═══
  These are fixed. Apply them to every component, every page, every artifact.

  COLOR TOKENS (define on :root, swap in dark mode):
    --color-buy:      #22c55e   (BUY signals, profit, positive delta)
    --color-sell:     #ef4444   (SELL signals, loss, negative delta)
    --color-wait:     #f59e0b   (WAIT state, caution, neutral)
    --color-bg:       #0f172a   (dark) / #f8fafc   (light)
    --color-surface:  #1e293b   (dark) / #ffffff   (light)
    --color-border:   #334155   (dark) / #e2e8f0   (light)
    --color-text:     #f1f5f9   (dark) / #0f172a   (light)
    --color-muted:    #64748b   (both modes)
    --color-accent:   #6366f1   (JARVIS brand — confidence highlights, active states)

  TYPOGRAPHY:
    Primary font: system-ui, -apple-system, sans-serif (no external CDN)
    Confidence %: 2.5rem bold — must dominate the card
    Asset name: 0.875rem muted — secondary
    Labels: 0.75rem uppercase tracking-wide

  DARK MODE:
    :root { /* light tokens */ }
    @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* dark tokens */ } }
    :root[data-theme="dark"] { /* dark tokens — same as above */ }

  LAYOUT:
    Signal cards: CSS grid, 3-column for desktop, 1-column for mobile
    Dashboard: sidebar nav (240px) + main content, collapses at < 768px
    No horizontal body scroll — wide content inside overflow-x: auto container

  INFORMATION HIERARCHY (every card must have):
    1. Asset + direction (biggest visual element)
    2. Confidence % and gap-to-fire
    3. Entry / Stop / Target (if signal is ready)
    4. Last updated timestamp (muted, smallest)

═══ STEP 3 — BUILD ═══
  a) Sketch the layout in comments before writing CSS (one ASCII line is enough)
  b) Write HTML structure — semantic, minimal nesting
  c) Write CSS — tokens first, then component styles
  d) Write JS — fetch from real endpoints, handle loading/error/empty states
  e) Test: does it look right at 1280px? At 1920px? In dark mode?
  f) No hardcoded values — every number must come from an API endpoint or CSS token

═══ STEP 4 — QUALITY GATE ═══
  Before committing:
  □ All signal colors match the token table above
  □ Confidence % is the dominant visual element on signal cards
  □ Dark mode looks correct (not just "works")
  □ Loading state is visible (skeleton or spinner — never a blank card)
  □ Error state is visible (red border + message — never a silent blank)
  □ Timestamps show human-readable age ("2 min ago") not raw ISO strings
  □ No hardcoded hex colors in component CSS
  □ No external CDN links (self-contained)

═══ STEP 5 — COMMIT & REPORT ═══
  git add [specific files] && git commit -m "design: [what was built/improved]"

  DESIGN REPORT:
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  BUILT:       [component / page name]
  TYPE:        [dashboard page / card / artifact / chart]
  DARK MODE:   [YES / NO — why not if no]
  RESPONSIVE:  [YES / NO]
  ENDPOINTS:   [which API routes it fetches from]
  QUALITY:     [all 8 gates passed / [N] failed — list failures]
  COMMITTED:   [hash]
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
