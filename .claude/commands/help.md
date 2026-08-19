Print the full JARVIS command reference.

Output exactly this:

---
JARVIS — SmartEntry Pro Command Reference
---

SIGNALS & ANALYSIS
  /signal              Live signal — all 3 assets + Fear & Greed context
  /analyze [sym]       Deep analysis — technical + sentiment + live news — BTC, GOLD, or SPX
  /scan                Parallel market scan — all assets scored and ranked
  /monitor             Continuous signal watcher — alerts when confidence ≥ the live gate
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
  /backtest [asset]    5-fold walk-forward backtest — real out-of-sample, worst-fold comparison
  /portfolio           Full portfolio view — open positions, P&L, exposure
  /profit              Autonomous profitability loop — researches + implements improvements, up to 5 rounds
  /goal [set|show|clear]  Set/track/clear the system's single most important goal — persists across sessions
  /learn               End-of-session learning — persist lessons, fixes, trades to memory. Run before closing.

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

DAILY & WEEKLY CYCLES
  /daily               Full daily check — health, deep errors, learning, research, ranked tasks
  /weekly              Deep weekly review — strategy research, code audit, calibration, plan
  /errors              Deep error scan — ALL logs, code anti-patterns, signal integrity
  /diagnose            Why is the system not opening trades? Full pipeline trace + fix
  /morning             Morning brief — signals + yesterday recap + pre-market research

SYSTEM & IMPROVEMENT
  /status              One-screen snapshot — signals, risk, code health, action item
  /health              Server + API + syntax + security health check
  /check [scope]       Deep check — syntax|security|api|git
  /verify              Full end-to-end verification — syntax + security + API + signals
  /fix [bug]           Autonomous bug finder and fixer — targeted or full scan
  /checksystem         Full diagnostic — all components + pending proposals
  /improve             Find worst setup and auto-improve parameters
  /agent               Autonomous loop — keeps fixing until system is clean

MEMORY
  Say: "remember that Gold rejects hard at $2400" — stored for all future sessions

AGENTS (spawn automatically via /engineer, /build, /daily, /weekly)
  analyst              Deep performance analysis — trajectories, calibration, failure patterns
  builder              Implements one workstream: read → build → verify → commit → report
  researcher           Multi-source research: Brave + Exa + web → synthesise → SmartEntry score
  tester               Full QA: syntax + secrets + live API + signal integrity → RED/YELLOW/GREEN
  code-reviewer        Reviews trading code changes for correctness, security, system integrity

---
Model: claude-opus-5 | Engineers: up to 6 parallel | Tools: Browser, Search, Filesystem, Memory
Session close: /learn (persist lessons) | Goal tracking: /goal show
All commands work inside the JARVIS PowerShell window. Just type and press Enter.
---
