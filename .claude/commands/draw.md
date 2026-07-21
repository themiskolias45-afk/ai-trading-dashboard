Draw the daily trading plan on TradingView charts. Usage: /draw [BTC|GOLD|SPX|all]

$ARGUMENTS is the symbol. If blank or "all", draw all three.

Steps:
1. Fetch http://localhost:3001/api/signals — get current signal for the symbol
2. Fetch http://localhost:3001/api/risk-status — get market regime
3. Determine key levels (use signal data; if WAIT use nearest pivots):
   - Entry, Stop, Target, Support, Resistance, Bias

4. For EACH symbol:

   METHOD A — Puppeteer MCP (direct browser control, preferred):
   Use puppeteer_navigate, puppeteer_evaluate, puppeteer_click to:
   a) Navigate to https://www.tradingview.com/chart/?symbol=[TV_SYMBOL]
   b) Check if logged in (look for user menu element)
   c) Open Pine Editor: puppeteer_click on '[data-name="pine-editor-activate-button"]'
   d) Clear + paste Pine Script via puppeteer_evaluate:
      document.querySelector('.cm-content').focus()
      // select all + replace with generated Pine Script
   e) Click "Add to chart"
   f) puppeteer_screenshot to confirm levels are visible

   METHOD B — Python bot (fallback if Puppeteer not available):
   Run: python tradingview_bot.py draw [SYMBOL] [entry] [stop] [target] [support] [resistance]
   The bot connects to Edge on port 9222 and draws via CDP.

   METHOD C — Pine Script save (last resort):
   Run: python tradingview_bot.py pine [SYMBOL] [entry] [stop] [target] [support] [resistance] [bias]

5. Report:
---
DAILY PLAN DRAWN — [SYMBOL] — [date]
---
Bias: [LONG/SHORT/WAIT]
Entry:      $X (green)
Stop:       $X (red)
Target:     $X (blue)
Support:    $X (light blue dotted)
Resistance: $X (light red dotted)
TradingView: DRAWN ✓
---
