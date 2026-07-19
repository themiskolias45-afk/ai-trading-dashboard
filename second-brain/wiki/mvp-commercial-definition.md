# MVP Commercial Definition

tags: mvp, commercial, product, onboarding, multi-user

## Summary

- The commercial MVP is a hosted, multi-user version of SmartEntry Pro where customers connect their own MT5 account and the system trades on their capital.
- Must-haves: multi-user support with per-customer API keys, MT5 onboarding flow, a simplified customer dashboard, and email trade alerts.
- Mobile app, custom asset selection, social features, and per-user backtesting are deferred to post-MVP.

## Full Notes

**Core Value Proposition**
- Themis provides the AI, signals, and infrastructure
- Customer provides the capital (their own MT5 account)
- No managed account licensing required for this model

**Must-Have Features**
- Multi-user support: each customer has their own API key tied to their own MT5 account
- Onboarding flow: connect MT5 → set risk level → go live
- Customer dashboard: personal dashboard layout, branded and simplified
- Email alerts: notification when trades fire
- Basic support channel

**Post-MVP (Deferred)**
- Mobile app
- Custom asset selection beyond BTC/Gold/SPY
- Social features: leaderboard, copy trading
- Advanced per-user backtesting

**Why This Scope**
- Each customer manages their own MT5 capital, avoiding managed account regulatory requirements
- Keeps initial build contained — essentially a multi-tenant hosted version of the existing system

## Related

- [commercial-product-ideas.md](commercial-product-ideas.md) — broader business model this MVP fits into
- [pricing-strategy.md](pricing-strategy.md) — $149/mo Trader tier maps to this MVP scope
- [eu-compliance-notes.md](eu-compliance-notes.md) — compliance requirements avoided by the "customer owns the MT5 account" model
- [smartentry-architecture.md](smartentry-architecture.md) — existing system that gets extended for multi-user
