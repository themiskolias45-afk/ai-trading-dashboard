# MT5 Bridge Stability

tags: mt5, infrastructure, reliability, python, reconnection

## Summary

- The MT5 Python bridge polls for signals and sends orders via `mt5.order_send()`, but lacks reconnection logic and health check pings.
- Key failure modes to address: idle connection drops, MT5 restart recovery, Python process memory leaks over 24h+, and broker server outages during live trades.
- `MAGIC_NUMBER=20250101` identifies SmartEntry trades in MT5 — all orders must carry this tag.

## Full Notes

**Current Setup**
- Bridge polls for signals at a fixed interval and sends orders via `mt5.order_send()`
- `MAGIC_NUMBER=20250101` tags all SmartEntry trades
- Run modes: `python mt5_bridge.py --auto` (full-auto) or without flag (semi-auto)

**Known Stability Risks**

| Risk | Status |
|---|---|
| MetaTrader5 Python connection drops after long idle | Unconfirmed, needs overnight test |
| Bridge reconnects if MT5 restarts | Not implemented |
| Memory leak in Python process over 24h+ | Not tested |
| Broker server down during a live trade | No handler defined |

**Work Needed**
- Add automatic reconnection logic when MT5 connection is lost
- Add health check ping to confirm bridge is alive
- Test stability over a full 24h+ run
- Define fallback behavior when broker is unreachable with an open position

## Related

- [smartentry-architecture.md](smartentry-architecture.md) — overall system architecture the bridge fits into
- [risk-management-rules.md](risk-management-rules.md) — circuit breakers that depend on the bridge being reliable
