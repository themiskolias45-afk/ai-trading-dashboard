# VAULT-INDEX

This file has two jobs: **your profile** and **the map of the vault**. JARVIS reads this at the start of every session.

---

## Profile — Themis

- **Location:** Greece
- **Focus:** Algorithmic trading — BTC, Gold (XAUUSD), S&P 500 (SPY)
- **System:** SmartEntry Pro v14 — Express.js server, Claude Opus AI, MT5 Python bridge
- **Broker:** MetaQuotes Ltd (demo/live MT5 account)
- **Balance:** ~$90,000 | Leverage: 1:500
- **Trading style:** Full-auto with Claude AI approval gate. Signal fires only at 65%+ confidence across D+4H+1H.
- **Risk rules:** 1% per trade, 3% daily loss limit, 3 consecutive loss halt
- **Working hours:** Flexible — system runs 24/7 unattended
- **GitHub:** themiskolias45-afk/ai-trading-dashboard
- **Project path:** `C:\Users\User\ai-trading-dashboard`
- **Vault path:** `C:\Users\User\Documents\Brain`

---

## Active Priorities

<!-- JARVIS updates this section as work progresses -->

- [ ] Monitor first live trades from SmartEntry Pro v14
- [ ] Run 5-year backtest and review win rate per asset
- [ ] Review AI Brain panel results after 1 week of signals

---

## Rules JARVIS Always Follows

1. Never commit `server/apikey.txt` or `keys.env`
2. Develop on branch `claude/backup-deploy-server-FWgpv`, merge to `main` when done
3. Model is always `claude-opus-4-8` — do not downgrade
4. Signal threshold is 65% confidence — do not lower it
5. Risk per trade stays at 1% — do not increase it

---

## Vault Structure

```
Brain/
├── VAULT-INDEX.md                  ← this file
├── Active Priorities.md            ← open tasks across all projects
├── 01 - Daily Notes/
│   ├── Daily Note Template.md      ← template for every daily note
│   └── NN - Month YYYY/
│       └── YYYY-MM-DD.md
├── 02 - Projects/
│   └── SmartEntry Pro/
│       └── SmartEntry Pro.md       ← system overview, decisions log
└── 03 - Notes/
    └── Trading/
        └── Signal Logic.md         ← how signals fire, parameters
```

---

## SmartEntry Pro — System Map

| File | Purpose |
|---|---|
| `server/index.js` | Express backend, all signal logic, Claude AI calls |
| `dashboard/index.html` | Trading dashboard UI |
| `mt5_bridge.py` | Python bridge to MetaTrader 5 |
| `START.bat` | One-click full-auto start |
| `stop.bat` | Stop everything |
| `CLAUDE.md` | JARVIS boot config (auto-loaded by Claude Code) |

---

## Decisions Log

| Date | Decision | Reason |
|---|---|---|
| 2026-07-18 | Set confidence threshold to 65% | Below 65% produces too many false signals |
| 2026-07-18 | Partial profit at 1R (50% close) | Locks in guaranteed profit before trailing |
| 2026-07-18 | Claude Opus as signal approver | Most capable model for trade evaluation |
| 2026-07-18 | 3% daily loss limit | Protects account from bad streaks |
