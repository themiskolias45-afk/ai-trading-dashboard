---
status: active
project: meta
type: index
---
# VAULT INDEX

Read this file at the start of every conversation. Two jobs: **who I am and how I work**, and **the map of this vault**. Your identity is in CLAUDE.md (the boot file), not here.

---

## Vault location

This vault lives at `C:\Users\User\Documents\Brain`.

---

## Who I Am

I'm Themis. I build algorithmic trading systems. Right now I run SmartEntry Pro — a 24/7 AI-powered trading system that monitors BTC, Gold, and SPY and executes trades automatically via MetaTrader 5. I'm building toward turning this into a professional commercial product — a high-quality trading system service for both retail traders and managed account clients.

## Key People

- **Themis** — me, the founder and sole developer of SmartEntry Pro

## SmartEntry Pro — Personal Trading System

My own live trading system, running on a $90,000 MT5 account at 1:500 leverage. Claude Opus AI approves every trade. Multi-timeframe signals (Daily + 4H + 1H), 1% risk per trade, 3% daily loss circuit breaker.

- **Status:** Active — live and trading
- **Tools:** Node.js, Express, Python, MetaTrader 5, Claude Opus (claude-opus-4-8), Yahoo Finance API
- **Location:** `C:\Users\User\ai-trading-dashboard`
- **Dashboard:** http://localhost:3001

## SmartEntry Pro — Commercial Product (in planning)

The next project: turn SmartEntry Pro into a professional, sellable trading system. Two customer types:
1. **Retail traders** — individuals who want algo trading without coding (SaaS subscription)
2. **Managed accounts** — investors who pay for the system to trade for them

This needs to be built to a significantly higher quality standard than the personal version — professional UI, reliability, compliance considerations, onboarding, support.

- **Status:** Planning — no product built yet
- **Next step:** Define what "professional quality" looks like and what the MVP is

## Vault Structure

```
C:\Users\User\Documents\Brain\
├── VAULT-INDEX.md              ← this file
├── Active Priorities.md        ← all open work
├── 01 - Daily Notes/
│   └── Daily Note Template.md
├── 02 - SmartEntry Pro/        ← personal system
├── 03 - SmartEntry Commercial/ ← the new business
└── 04 - Resources/             ← templates, Jobs, reference
```

## What's Active Right Now

All open work: [[Active Priorities]]

---

## My Preferences for Working with AI

- **Direct and short.** One sentence where possible. No openers like "Great!" or "Certainly!".
- **Do it, then report.** Don't narrate what you're about to do — just do it and tell me what changed.
- **No fluff.** No summaries of what we just discussed. No suggestions to take a break.
- **When I send a screenshot, tell me what's relevant and act on it.**
- **Trading context first.** Every decision should consider signal quality, risk, and system reliability.
- **One question at a time — then stop.** Wait for my answer before continuing.
- **Never suggest stopping.** I decide when we're done.
- **Fix it now.** Don't defer bugs or problems without my explicit approval.

---

## How My Memory Works (for the AI)

This vault is your memory — external and unlimited. Hold only what the current task needs; reach for everything else on demand. Start at this index, follow folder indexes and wikilinks, or search. Knowing a note exists is as good as holding it.

---

## Vault Rules for AI

### Frontmatter

Every note gets YAML frontmatter. Infer the values — never ask me.

```yaml
---
status: active
project: smartentry-personal | smartentry-commercial | personal | meta
type: index | reference | guide | plan | log
---
```

### Checkpoint Persistence

When something changes that a future session needs to know: update the relevant note, today's daily note, and CLAUDE.md (only for a new always-on rule). Verify it landed. The vault is the memory — keeping it current is not busywork.

### Daily Notes

Live in `01 - Daily Notes/`, filename `YYYY-MM-DD.md`. Always create from `Daily Note Template.md`. If today's exists, append a new session — don't overwrite. Timestamp with my local time.

**Trigger:** When I signal I'm done, offer to log the day. At session start, check yesterday's note and backfill if you have context it's missing.

### Living Profile

Update **Key People, How I Think, Personal Interests** as you learn through conversation. Log every update in the daily note under "Profile Updates." Never change project sections or Vault Rules on your own initiative.

### Archiving

Always confirm before archiving anything. Never archive on your own initiative.
