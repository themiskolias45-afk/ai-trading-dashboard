Print the full JARVIS command reference.

Output exactly this:

---
JARVIS — SmartEntry Pro Command Reference
---

SIGNALS & ANALYSIS
  /signal              Live signal — all 3 assets + Fear & Greed context
  /analyze [sym]       Deep analysis — technical + sentiment + live news — BTC, GOLD, or SPX
  /scan                Parallel market scan — all assets scored and ranked
  /monitor             Continuous signal watcher — alerts when confidence ≥ 65%
  /sentiment           Full sentiment brief — Fear & Greed + macro + asset outlook
  /news                Live market news briefing + trading impact
  /morning             Full morning brief — signals + sentiment + pre-market research

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
  /profit              Autonomous profitability loop — researches + implements improvements, up to 5 rounds

CODE & BUILD
  /think [task]        Deep analysis mode — force explicit reasoning before implementing
  /plan [task]         Architect a solution before writing any code
  /build [feature]     Build any new feature — check exists, plan, quality gates, test, commit
  /engineer [task]     Spawn real parallel Claude agents — up to 6 simultaneously
  /debug [problem]     Read logs → trace root cause → fix it
  /refactor [file]     Clean up dead code, fix names, split functions
  /test [function]     Write and run tests — all pass before done. /test alone = full system test

RESEARCH
  /research [topic]    Multi-source deep research (Brave + Exa + web scrape) → implement
  /web [task]          Full browser control — any website, any interaction

SYSTEM & IMPROVEMENT
  /status              One-screen snapshot — signals, risk, code health, action item
  /health              Server + API + syntax + security health check
  /check [scope]       Deep check — syntax|security|api|git (no Python needed)
  /verify              Full end-to-end verification — syntax + security + API + signals
  /fix [bug]           Autonomous bug finder and fixer — targeted or full scan
  /checksystem         Full diagnostic — all components + pending proposals
  /improve             Find worst setup and auto-improve parameters
  /agent               Autonomous loop — keeps fixing until system is clean
  /state save          Save full session state to resume next time
  /state load          Restore last session — pick up exactly where you left off

MEMORY
  Say: "remember that Gold rejects hard at $2400" — stored for all future sessions

AGENTS (spawn automatically via /engineer or /build)
  builder              Implements one workstream: read → build → verify → commit → report
  researcher           Multi-source research: Brave + Exa + web → synthesise → SmartEntry score
  tester               Full QA: syntax + secrets + live API + signal integrity → RED/YELLOW/GREEN
  code-reviewer        Reviews trading code changes for correctness, security, system integrity

---
Model: claude-opus-5 | Engineers: up to 6 parallel | Tools: Browser, Search, Filesystem, Memory
All commands work inside the JARVIS PowerShell window. Just type and press Enter.
---
