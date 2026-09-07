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
  DO NOT COPY A PALETTE INTO A PAGE. Link the shared sheet and use its tokens:

      <link rel="stylesheet" href="/dashboard/theme.css">   <!-- LAST in <head> -->
      <link rel="stylesheet" href="/dashboard/nav.css">
      <script src="/dashboard/nav.js" defer></script>

  CORRECTED 2026-08-23. The table that used to sit here prescribed #0f172a ground,
  #6366f1 accent, #22c55e green and a 240px sidebar. NONE of that ships, and building
  to it re-fragments the exact thing dashboard/theme.css was created to fix: on
  2026-08-19 ten pages were carrying FOUR different palettes — four grounds, three
  purples, an orange, and two different greens for the same idea. A doc that hands the
  next author a fifth palette is worse than no doc. It already cost one: the healer
  chips shipped with rgba(34,197,94,.3) — #22c55e, straight off the old table — three
  shades from the green every other panel used, on a page that had just been unified.

  THE TOKENS ARE IN dashboard/theme.css AND THAT FILE IS THE SOURCE OF TRUTH.
  Read it before designing; these are the ones you will reach for most:

    --bg #070b12   --surface #0d1420   --surface2 #121a28   --surface3 #18212f
    --border #1e2a3d      --border2 #2b3a52
    --text #e8eef7        --muted #8aa0c0       --muted-dim #7488ab
    --green #2bd07c (BUY, profit, pass)         --red #f2555f (SELL, loss, fail)
    --yellow/--amber #f0b429 (WAIT, caution)    --blue #4a9eff
    --accent #7c5cff (JARVIS brand)             --accent-warm #f7931a (commercial only)
    --radius 10px  --radius-sm 7px  --radius-lg 14px
    --font Inter / --mono JetBrains Mono

  TRAPS, each one measured rather than assumed:
    * --dim (#2b3a52) is a BAR-TRACK colour, not a text colour. Three pages used it for
      body copy at 1.72:1. If a page uses a token it does not define, check what
      theme.css means by that name before assuming.
    * A contrast figure is meaningless without the background it was measured against.
      --muted-dim passes AA on all four surfaces; quote the pair, not the number.
    * theme.css sets NO layout property beyond three stated exceptions. Component
      layout belongs in the page's own <style>. Do not add layout to theme.css.

  TYPOGRAPHY:
    Inter, with 'Segoe UI'/system-ui fallbacks — already set by theme.css --font.
    Mono is JetBrains Mono (--mono) for tickers, gate names and code-ish values.
    TABULAR NUMERALS on every price, count and table cell. Without them a price
    ticking 4414.05 -> 4409.80 shifts every digit sideways and a P&L column will not
    align. This is the highest-value typographic rule on a trading screen.
    Confidence %: must dominate its card.  Labels: small, uppercase, tracked.

  DARK MODE:
    SmartEntry Pro is DARK-ONLY and deliberately so — one palette, ten pages, no
    light tokens anywhere. Do not add a prefers-color-scheme swap to a dashboard page;
    there is no light variant to swap to and a half-built one is worse than none.
    (A standalone artifact published outside the system is the exception — load the
    artifact-design skill and follow its theming rules there.)

  LAYOUT:
    Nav is a SHARED TOP RAIL, not a sidebar: dashboard/nav.css + nav.js render it on
    every page from one PAGES array. ADDING A PAGE IS ONE ROW IN THAT ARRAY — never
    hand-roll header links, which is how eight pages ended up with seven different
    class names for "link to another page".
    Signal cards: CSS grid, multi-column desktop, single-column mobile.
    No horizontal BODY scroll — wide content scrolls inside its own overflow-x
    container. Grid items default to min-width:auto and will not shrink below their
    content, so one long nowrap child widens every sibling in the row.

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
  e) Test at 390px, 1280px and 1920px. Measure, do not eyeball: drive a real browser,
     and filter horizontal-overflow hits to elements NO ancestor clips or scrolls, or
     the list is dozens of table cells already scrolling correctly.
     A STATE THAT IS NEVER RENDERED IS A STATE THAT WAS NEVER BUILT — drive the empty,
     loading, error and stale paths, not just the happy one. Note that a page with a
     service worker will serve /api/ from it, so request interception may never reach
     the page; stub the page's own fetch helper and re-call the render function.
  f) No hardcoded values — every number must come from an API endpoint or CSS token

═══ STEP 4 — QUALITY GATE ═══
  Before committing:
  □ Every colour comes from a theme.css token — no hex literal in component CSS
  □ theme.css is linked LAST in <head>, and nav.css/nav.js are linked
  □ Status is carried by a glyph or weight AND a colour, never colour alone
  □ Anything time-sensitive shows its AGE. A tick with no age is not evidence:
    the healer showed 8/8 green for 8h32m while every python process was dead
  □ Confidence % is the dominant visual element on signal cards
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
