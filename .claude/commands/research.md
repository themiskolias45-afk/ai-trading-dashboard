Deep multi-source research on a trading strategy or market topic. Usage: /research [topic]

If $ARGUMENTS is empty, ask: "What do you want to research?"

═══ STEP 1 — PARALLEL MULTI-SOURCE FETCH ═══
Search all three sources simultaneously for the topic:

Source A — Brave Search:
Use brave-search MCP to get the top 10 results. Note titles, URLs, snippets.

Source B — Exa AI Search:
Use exa MCP (exa_search tool) with query focused on academic/professional sources.
Ask for: research papers, quant blogs, professional trading sites.

Source C — Web scrape top results:
Use Puppeteer or fetch MCP to read full content from the top 2-3 URLs that look most relevant.
Extract the actual strategy rules, backtested stats, win rates.

═══ STEP 2 — SYNTHESISE ═══
Combine all sources. Look for:
- Consensus across sources (high confidence if 2+ sources agree)
- Specific entry/exit rules (not vague ideas — exact conditions)
- Backtested win rates, R:R, drawdown data
- Which market conditions the strategy works best in
- What makes it fail

═══ STEP 3 — EVALUATE FOR SMARTENTRY ═══
Can this be coded into generateSignal() in server/index.js?
Score it on:
- Codeable: can every rule be expressed in JS with the data we already have? (MACD, RSI, BB, ATR, price)
- Edge: is there real data showing > 55% win rate?
- Fit: does it work on BTC, Gold, or SPX in the timeframes we trade (Daily + 4H + 1H)?

═══ STEP 4 — DECIDE ═══
If all three score YES:
  → Write a 3-bullet implementation plan
  → Show the exact generateSignal() logic change
  → Ask: "Build it now? (Y/N)"

If any score NO:
  → Explain exactly why it won't work here
  → Suggest what to search for instead that would fit better

Focus only on what can be coded and backtested. No generic advice.
