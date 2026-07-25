Print the full JARVIS command reference.

Output exactly this:

---
JARVIS — SmartEntry Pro Command Reference
---

SIGNALS & ANALYSIS
  /signal              Live signal — all 3 assets, confidence, entry/stop/target
  /analyze [sym]       Deep analysis with sequential reasoning — BTC, GOLD, or SPX
  /scan                Parallel market scan — all assets scored and ranked
  /monitor             Continuous signal watcher — alerts when confidence ≥ 65%
  /news                Live market news briefing + trading impact
  /morning             Full morning brief — signals + performance + today's priority

TRADINGVIEW
  /draw [sym]          Draw daily plan on TradingView — entry/stop/target/S&R lines
  /tv plan             Draw all 3 charts (BTC + GOLD + SPX) in one go
  /tv alert [sym] [price]   Set a price alert on TradingView
  /tv pine [sym]       Generate Pine Script only (paste into TV editor)
  /tv login            Test TradingView connection

TRADE EXECUTION
  /execute [sym] [dir] [entry] [stop] [target]   Force-execute a manual trade
  /trade [details]     Log a completed trade to journal
  /risk [sym] [entry] [stop]    Position size + risk check

PERFORMANCE & LEARNING
  /journal             Last 20 trades with P&L summary
  /review              Weekly performance review + brutally honest what to fix
  /selflearn           What the AI learned — win rates + boosts per setup
  /backtest [idea]     Backtest a setup against historical data
  /portfolio           Full portfolio view — open positions, P&L, exposure

CODE & BUILD
  /plan [task]         Architect a solution before writing any code
  /build [feature]     Build any new feature or tool from scratch
  /engineer [task]     Spawn real parallel Claude agents — up to 6 simultaneously
  /debug [problem]     Read logs → trace root cause → fix it
  /refactor [file]     Clean up dead code, fix names, split functions
  /test [function]     Write and run tests — all pass before done

RESEARCH
  /research [topic]    Multi-source deep research (Brave + Exa + web scrape) → implement
  /web [task]          Full browser control — any website, any interaction

SYSTEM & IMPROVEMENT
  /health              Server + bridge + system health check
  /checksystem         Full diagnostic — all components + pending proposals
  /improve             Find worst setup and auto-improve parameters
  /agent               Autonomous loop — keeps fixing until system is clean
  /state save          Save full session state to resume next time
  /state load          Restore last session — pick up exactly where you left off

MEMORY
  Say: "remember that Gold rejects hard at $2400" — stored for all future sessions

---
Model: claude-opus-5 | Engineers: up to 6 parallel | Tools: Browser, Search, Filesystem, Memory
All commands work inside the JARVIS PowerShell window. Just type and press Enter.
---
