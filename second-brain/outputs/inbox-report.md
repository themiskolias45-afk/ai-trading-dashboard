# Inbox Processing Report — 2026-07-19

10 inbox files processed. 10 wiki notes created.

---

## Main Themes

### 1. System Architecture & Infrastructure
The core engine (Node.js + Express, Python MT5 bridge, Claude Opus signal approval) is defined and running, but has unresolved reliability gaps — specifically the MT5 bridge has no reconnection logic and no overnight stability validation. The architecture is sound; the operational hardening is not done.

**Next action:** Implement MT5 bridge reconnection logic and run a supervised 24h stability test before treating the system as production-ready.

---

### 2. Signal Quality & Performance Validation
The 65% confidence threshold and 1% risk rule are active on live capital, but neither has been validated against data. The backtest module exists and has not been analyzed. Signal logging only captures executed trades, not all signals that fire. There is no per-asset win rate or profit factor number on record.

**Next action:** Run and document the 5-year backtest analysis, then implement the signal accuracy log to begin collecting live validation data.

---

### 3. Commercialization Path
There is a clear two-phase commercial plan: SaaS retail product first ($149/$299/mo), managed accounts later once licensed. The MVP is well-scoped — multi-tenant hosted SmartEntry where customers bring their own MT5 accounts, sidestepping managed-account regulation. Pricing is benchmarked and reasonable.

**Next action:** Begin MVP technical scoping — specifically multi-user auth and per-customer MT5 connection isolation.

---

### 4. Regulatory Compliance (EU / MiFID II)
Managing client money in Greece/EU requires MiFID II authorization from the HCMC, likely EUR 75k minimum capital and full suitability/reporting obligations. The current MVP design (customer owns MT5, Themis provides signals) is specifically structured to avoid triggering this requirement. The white-label broker route is a viable alternative if managed accounts are pursued later.

**Next action:** Consult a Greek financial lawyer to confirm whether the SaaS/signal-provider model requires any HCMC registration at all, and to map the managed-account licensing path for later.

---

## Tensions & Contradictions Worth Flagging

### Tension 1: Live capital deployed before performance is validated
`backtest-results-todo.md` and `signal-accuracy-tracking.md` together reveal that the system is running on a $90k MT5 account with a 65% confidence threshold and 1% risk rule that have not been backtested or validated with live signal data. The backtest module exists but the results have never been formally reviewed. The signal log only captures executed trades, not all signals. This means circuit breakers and risk rules are calibrated without any evidence base. The system could be operating at the wrong threshold in either direction — too conservative (missing edge) or not conservative enough (overfitting to confidence scores that don't predict outcomes).

### Tension 2: Managed accounts deferred to compliance, but pricing strategy already includes them
`pricing-strategy.md` includes the performance fee model for managed accounts as a planned tier, and `commercial-product-ideas.md` lists it as a customer segment. However, `eu-compliance-notes.md` makes clear that this requires MiFID II authorization from the HCMC — a process that involves minimum EUR 75k capital, client suitability frameworks, and regulatory reporting. The commercial planning treats managed accounts as "build later when licensed," but no licensing timeline or budget has been allocated, making it an indefinitely deferred item rather than a planned phase.
