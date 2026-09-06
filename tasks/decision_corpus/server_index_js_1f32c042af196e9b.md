---
decision_key: 1f32c042af196e9b
source: server/index.js:4069
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

DO NOT flip this to false on the strength of "the system never sells". It admits

Governs: `const SELL_BOUNCE_REQUIRE_DOWNTREND = true;`

## The reasoning as recorded

SELL_BOUNCE's condition 1 — see the branch for the measurement. TRUE reproduces the
engine exactly as it has always run; the flag exists so both worlds can be replayed
and compared instead of argued about. `tasks/_replay_mtf.cjs` overrides it through
MTF_SELL_BOUNCE_REQUIRE_DOWNTREND, measurement-only.

DO NOT flip this to false on the strength of "the system never sells". It admits
roughly 500 additional shorts and the SELL side's measured mean is -0.058R against
BUY's +0.315R, so the expected first-order effect is a LOSS. What would justify the
flip: a per-asset walk-forward at the live gate and MAX_HOLD=320 where the candidate
world's WORST FOLD beats the baseline's on XAUUSD and SP500 — the two assets that sit
at confidence 0 in a bearish tape — without degrading BTCUSD.

THAT WALK-FORWARD RAN, AND THE ANSWER IS NO. Measured 2026-09-01 per asset at
MAX_HOLD=320: XAUUSD goes 308 trades / worst fold +0.086, 5/5 ROBUST -> 287 trades /
-0.087, 4/5. Gold gets WORSE and its trade COUNT FALLS, because a SELL_BOUNCE that
matches DISPLACES a long setup sitting later in the else-if chain. Additive in bars,
subtractive in outcomes — the same occupancy cost tasks/breakdown_walkforward.cjs
measures for BREAKDOWN, and the reason "it is purely additive" is never a safety
argument on its own in a first-match-wins chain.

This result existed ONLY ON THE VPS until 2026-09-02, written into that box's copy of
this comment and never brought back. The laptop went on carrying the question after
the answer was known, which is how the same measurement gets commissioned twice. If
you patch a box directly, the reasoning you leave in the file there is invisible to
every other box — run `node tasks/vps_parity.cjs`, which is what surfaced this.
A PLAIN LITERAL, deliberately. The first version read process.env here, and
_replay_mtf.cjs runs the extracted engine inside a `vm` context where `process` does
not exist — so every replay died with "ReferenceError: process is not defined". It
failed loudly, which is the only reason it was caught; a quieter version of the same
mistake is the bug SCALAR_CONSTS exists to prevent. The replay overrides this through
MTF_SELL_BOUNCE_REQUIRE_DOWNTREND at extraction time instead.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
