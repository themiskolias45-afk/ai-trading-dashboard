# EA source, tracked here because it existed in ONE place

`EA_CRT_AMD_Dashboard` is live trading logic that lived only inside a single MT5 data
folder on the laptop — not in git, not on the VPS, not in any backup. A terminal
reinstall or a profile reset would have taken it with no copy anywhere.

- `EA_CRT_AMD_Dashboard_v355.mq5` — what is attached to XAUUSD M15 today.
- `EA_CRT_AMD_Dashboard_v356.mq5` — v3.55 plus the config-sentry fix. **Every `input` is
  byte-identical to v3.55 and the magic is unchanged (26070455), so trading behaviour is
  the same and the ledger record stays continuous.** The change is display and logging
  only: `g_cfgSentryOK` is read at exactly one place, to choose a colour.

These are copies for safekeeping. The build MT5 compiles is the one in the MQL5 folder.
