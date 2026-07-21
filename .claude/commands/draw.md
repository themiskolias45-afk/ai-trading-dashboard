Draw the daily trading plan on TradingView charts. Usage: /draw [BTC|GOLD|SPX|all]

$ARGUMENTS is the symbol. If blank or "all", draw all three.

Steps:
1. Fetch http://localhost:3001/api/signals — get current signal for the symbol
2. Fetch http://localhost:3001/api/risk-status — get market regime
3. Use sequential thinking to determine key levels:
   - Entry: exact signal entry price
   - Stop: signal stop loss
   - Target: signal take profit
   - Support: nearest significant support below current price
   - Resistance: nearest significant resistance above current price
   - Bias: LONG / SHORT / WAIT based on signal

4. For EACH symbol requested:

   a) DRAW on TradingView (opens browser, logs in, draws lines):
      Run: python tradingview_bot.py draw [SYMBOL] [entry] [stop] [target] [support] [resistance]

   b) GENERATE Pine Script (backup — paste into TV if automation fails):
      Run: python tradingview_bot.py pine [SYMBOL] [entry] [stop] [target] [support] [resistance] [bias]

5. Report:
   ---
   DAILY PLAN DRAWN — [SYMBOL] — [date]
   ---
   Bias: [LONG/SHORT/WAIT]
   Entry:      $X (green line)
   Stop:       $X (red line)
   Target:     $X (blue line)
   Support:    $X (light blue dotted)
   Resistance: $X (light red dotted)

   TradingView: DRAWN ✓ / Pine Script saved to tasks/pine_[symbol]_plan.pine
   ---

If TradingView automation fails (browser issue), fall back to Pine Script and tell the user to paste it into TV's Pine Script editor.

If credentials not set: tell user to run tasks\setup_tradingview.bat first.
