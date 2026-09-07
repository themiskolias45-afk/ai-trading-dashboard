Run chart vision analysis on a live chart screenshot. Usage: /vision [BTC|GOLD|SPX]

$ARGUMENTS: BTC, GOLD, or SPX. If empty, analyze all three.

Runs the Python chart vision tool against the latest chart screenshot for the specified asset.
Interprets: trend structure, support/resistance levels, candlestick patterns, momentum signals.
Cross-references with live signal confidence from /api/signals.

═══ STEP 1 — CAPTURE ═══
  If no recent screenshot exists (tasks/screenshots/ or dashboard/screenshots/):
    Run: node tv_screenshot.cjs --symbol [asset]
    Wait for screenshot file to be written.

═══ STEP 2 — ANALYSE ═══
  Run: python chart_vision.py [BTC|GOLD|SPX]
  Capture full output — includes: trend bias, key levels, pattern match, recommendation.

═══ STEP 3 — CROSS-REFERENCE ═══
  Call: mcp__smartentry__get_signals → current confidence for the asset
  Call: mcp__smartentry__get_strategy_settings → live confidenceThreshold

  Compare chart vision output to signal engine:
  - Does chart bias (BULL/BEAR) match current signal direction?
  - Does chart structure explain why confidence is [X]% (high/low)?
  - Are there visible S/R levels the engine may be responding to?

═══ STEP 4 — REPORT ═══
VISION — [asset] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHART BIAS:  [BULLISH / BEARISH / NEUTRAL]
KEY LEVELS:  [S/R prices]
PATTERN:     [pattern name if detected]
ENGINE:      conf [X]% | signal [direction] | gap [Gpt] from gate
ALIGNMENT:   [chart and engine AGREE / DISAGREE — one sentence why]
INSIGHT:     [one actionable observation]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
