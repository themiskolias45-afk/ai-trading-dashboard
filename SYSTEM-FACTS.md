# System Facts

**What this file is.** The facts about SmartEntry Pro that a session needs and that
change on the code's clock, not the rulebook's. Split out of CLAUDE.md on 2026-09-07
because mixing them was doing measurable damage: a stale line number or gate value in
the boot file makes a reader discount the whole file, and on 2026-09-02 four claims in
CLAUDE.md were found stale at once — one of them sending every session to
`GET /api/performance`, a route that does not exist.

**The contract.** Every claim here is falsifiable and `tasks/claims_check.cjs` verifies
it against the code and the live server. It runs at session start via
`tasks/hooks/startup-check.ps1`, so drift surfaces as a startup warning rather than as
a wrong conclusion three hours in. **When you add a fact here, make it checkable, or
say plainly that it is not.**

**Read this before grepping for a system fact.** On 2026-09-07 a session needing "how
many assets does this trade" — a fact unchanged in three months — had nowhere to look
it up, because six memory stores all held what HAPPENED and none held what the system
IS. That is what the next section is for.

---

## What the system IS

**Three instruments. It has always been three.** Not four, not five. Any diagram
showing MSFT or AMZN as traded is wrong — those appear only in
`tasks/instrument_universe_scan.cjs`, a screening tool.

| key | broker symbol | Yahoo feed |
|---|---|---|
| `gold` | XAUUSD | GC=F |
| `btc` | BTCUSD | BTC-USD |
| `spx` | SP500 | ^GSPC |

Defined at `server/index.js:4053`, aliased at `:4306-4308`, asserted at `:5381`,
mapped in `mt5_bridge.py:123-126`. Four independent places, all agreeing.

**Two machines, one engine.**
- Laptop — where code is written. Claude/JARVIS runs here and nowhere else interactive.
- VPS `169.58.74.133` (Contabo, Windows, 24/7) — the box that trades continuously.
  `claude -p` batch runs there daily and weekly, constrained to *report only, do not
  edit code*.

**Engine size** — `server/index.js` and `mt5_bridge.py`. Never quote a line count from
memory; `wc -l` is authoritative and both files change most days.

**Entry points that matter**
- `generateSignal` — `server/index.js:1780`
- `generateSignalMTF` — `server/index.js:3062` (the MTF path the prose describes)

**What this system does NOT have.** Recorded because architecture diagrams have
claimed all of them:
- No machine learning. No xgboost, LSTM, tensorflow, sklearn or torch anywhere. The
  engine is rule-based: EMA stacking, RSI, MACD, ATR.
- No PostgreSQL. It is SQLite via `better-sqlite3` (`server/db.js:8`).
- No Docker, no systemd. The VPS is Windows with scheduled tasks.
- No React, no mobile app, no JWT. Static HTML dashboard, session-gated routes.

**The gate is deliberately not written here.** Read it from
`GET /api/strategy-settings` (`confidenceThreshold`). If `settingsError` is non-null
## SmartEntry Pro — always-on rules

- The system runs on `http://localhost:3001`
- API key lives in `server/apikey.txt` — **never commit it**
- `keys.env` — **never commit it**
- Git branch for development: `claude/backup-deploy-server-FWgpv` (push here, then merge to main)
- MT5 bridge: `python mt5_bridge.py --auto` for full-auto, no `--auto` for semi-auto
- Models: `claude-opus-5` for the JARVIS brain and the /engineer workstream split;
  `claude-sonnet-5` for per-asset commentary, summaries and analysis. Do not
  reintroduce `claude-opus-4-8` — both remaining call sites were upgraded 2026-08-02.
- **THE TIMEFRAMES ARE NOT ALL REQUIRED TO AGREE. This line used to claim they were.**
  It read *"Signal fires only at or above the live `confidenceThreshold` across Daily +
  4H + 1H"*, which states a safety property the engine does not have and which a user
  reasonably read as "it will not buy into a bearish 4H/1H". Corrected 2026-08-31 after
  being asked why it buys when every lower timeframe is red. What `generateSignal`
  actually does (`generateSignalMTF`, `server/index.js:3350`; the plain
  `generateSignal` is at `:2016`. This said `:2814-2911` until 2026-09-02 — that
  range is neither function):
  - Daily + H4 **agree** → 72 / 88 / 95.
  - Daily + H4 + H1 **all agree** → 88 / 97. This is a **BONUS branch, not a gate.**
  - Daily fires while **H4 says WAIT** → **72 on Gold**, which clears the gate (70; it
    was 65 for part of 2026-09-01 and cleared either) with H4 not agreeing. Gold-only and evidenced
    (+0.464R over 424 held-out trades), but it is a real path to a fill without H4
    confirmation.
  - H4-only, daily WAIT → 55 / 63 / 68. **This band moves with the gate, so re-read it
    whenever the gate moves.** At the live gate of 70 all three sit BELOW it and the
    cohort cannot fire without boosts. During the 65 excursion on 2026-09-01 the 68
    cohort cleared unaided and the 63 was two points away. The gate is back at 70, so
    "H4-only cannot fire without boosts" is true again — but it is true by CONFIGURATION,
    not by construction, and it silently reverses the moment the gate drops below 68.
  **Only ONE branch anywhere lets `h1` touch the confidence maths** — the
  triple-alignment bonus at `server/index.js:3493` — plus a display copy in the
  payload at `server/index.js:3827`. This line claimed "`h1` appears exactly TWICE in
  the whole engine" until 2026-09-06, when it appeared **31 times** and both cited
  lines had rotted onto unrelated code. **Do not restore a raw count here**: the count
  is the part that went stale, the PROPERTY is the part that matters, and the property
  was re-verified on 2026-09-06 — the bonus is guarded on `daily.signal !== "WAIT"`
  and only ever ASSIGNS 88 or 97 over a value that was at most 95, so it can only
  RAISE. **No branch anywhere lets H1 reduce confidence or block a
  setup**, and the bridge never reads `h1` or `m15` to refuse a trade. A bearish H1 and
  a bearish M15 are DISPLAY ONLY. Whether H1 disagreement predicts anything is
  UNMEASURED — see `tasks/logs/h1_agreement.txt`. Do not add an H1 veto on intuition:
  that is subtraction, it spends the scarce resource, and rule 3 governs it.
- **"STRONG UPTREND" is EMA STACKING, NOT CANDLE DIRECTION** (`index.js:2064`;
  said `:1711`, then `:1798` — both rotted by insertions above them):
  `price > ema20 && > ema50 && > ema200`. On 2026-08-31 Gold printed STRONG UPTREND
  while sitting **$1.55 above its 20 EMA** with MACD histogram −5.35 and
  `crossedBearish: true`. The label says where price IS, never where it is going. The
  setup that fires there is named `BUY_OVERSOLD` and buys the fall on purpose — H4 RSI
  27.2, H1 RSI 23.7 that day. Both readings are correct; they measure different things.
- **The gate is 70.** Verified on both boxes 2026-09-02: laptop 70, VPS 70,
  `settingsError` null on each. `server/strategy_settings.json` carries
  `"confidenceThreshold": 70`, `updatedAt 2026-09-01T17:07:14Z`, `updatedBy dashboard`.
  - **It was 65 for part of 2026-09-01, and this file went on saying so for a day after
    it changed back.** The user moved 70 → 65 that morning for trade FREQUENCY, then set
    it back to 70 from the dashboard at 17:07Z the same day. The bullet that stood here
    announced 65 in bold and instructed the reader to "never quote 70 from this file
    again" — so the correction written to stop this file lagging the config became,
    within hours, the longest-lived wrong claim in it. That is precisely the failure this
    bullet exists to prevent, committed by the bullet itself.
  - **So do not trust this line either.** `GET /api/strategy-settings` is the only
    authority, and `node tasks/config_drift.cjs` flags this file the moment it drifts
    again — it is what caught this. If `settingsError` is non-null the server is running
    on built-in defaults rather than the saved config: say so before anything else.
  - The choice, `MTF_MAX_HOLD=320`, 5 folds, 0.05R, from the baseline table of
    `tasks/breakdown_walkforward.cjs`. In that baseline table **every gate 45–85 is 5/5 positive at this
    horizon**, so this is frequency vs per-trade quality, NOT good vs bad:

    | gate | closed | R/trade | worst fold |
    |---|---|---|---|
    | 55 | 619 | +0.255 | +0.034 |
    | **65** | **494** | **+0.323** | **+0.053** |
    | 70 (was) | 454 | +0.369 | +0.055 |
    | 75 | 275 | +0.360 | +0.219 |

    65 buys ~9% more trades at a worst fold of +0.053 against 70's +0.055 — effectively
    unchanged — for about 5% less total R (159R vs 168R). Total R peaks at 70; COUNT is
    what 65 would buy, and sample size is the binding constraint. **This table is the
    argument FOR 65 while the live gate is 70.** That is a standing disagreement between
    the evidence and the setting, not an error in either — 65 was tried and reverted the
    same day. Whoever moves it next should say which of the two they are acting on.
  - **THE OLD NUMBERS IN THIS BULLET WERE PROBABLY AN ARTIFACT.** It used to report the
    2026-08-18 run as 4/5 with "65 DEGRADED to 2/5 UNSTABLE" and "85 negative in 4 of 4".
    That run used the harness default `MTF_MAX_HOLD=40`, which scores an unresolved trade
    as EXPIRED — and **the live system has no max-hold at all**. Corrected to 320 the same
    data turned SP500 from `0/5 CONSISTENTLY NEGATIVE` into `4/5 MOSTLY POSITIVE`. Any
    gate verdict quoted without its hold horizon is not a verdict.
  - **Re-measure per ASSET, never pooled.** Added 2026-09-01 to `mtf_walkforward.cjs`
    (ae4a197) because every verdict here had been pooled across three assets and then
    used to answer asset-specific questions. At gate 70 / 320: XAUUSD 5/5 +0.051,
    BTCUSD 5/5 +0.172, SP500 4/5 −0.042.
- **Gold's squeeze cohort is pinned to a LITERAL 70** (`GOLD_SQUEEZE_MODERATE_CONFIDENCE`,
  `server/index.js:3443`; said `:3486`, then `:3553`, then `:3650` — rotted three times, twice by
  edits made the same day) — it
  did NOT follow the gate down. At 65 it still clears
  comfortably; it silently stops firing only if the gate is ever raised ABOVE 70. Moving
  the gate DOWN was the safe direction; moving it up is the one that needs this checked.
- `strategy_settings.json` is per-machine and untracked, so a shared commit does NOT
  mean shared behaviour — change it on the laptop AND the VPS. Never write it with
  PowerShell `Set-Content -Encoding utf8`: that emits a UTF-8 BOM and on 2026-08-02 it
  silently reset the VPS to defaults, turning fixedLotSize 0.01 into full risk-based
  sizing. Use `[System.IO.File]::WriteAllText($p,$json,(New-Object System.Text.UTF8Encoding($false)))`.
- Auto-healer: monitors server health every 30s, auto-recovers stale data
- Healer status: GET http://localhost:3001/api/healer
- Force heal: POST http://localhost:3001/api/healer/heal
- Performance dashboard: http://localhost:3001/dashboard/performance.html
  (the page, not an endpoint — there is no `/api/performance`, and nothing calls one)
- Autostart: `tasks\install_autostart.ps1` registers "SmartEntry Ensure Running" on
  logon + workstation unlock + every 10 min. Logon-only triggers never fire when a
  laptop lid is opened. `tasks\ensure_running.ps1` fills gaps and never kills, so it
  is safe to run any time; check `tasks\logs\ensure_running.txt`.
- Bridge liveness is `GET /api/mt5/health?account=A|B` — NOT a process check. Windows
  returns an empty command line for the bridge python processes, so they look absent
  while trading normally.
- Chart vision: python chart_vision.py [BTC|GOLD|SPX]
- Voice: python voice.py --loop
- Signal debate: python debate_agents.py [SYMBOL] [DIRECTION] [confidence] [entry] [stop] [target]
- Notifications: python notifications.py test (verify channels)
- Memory: python memory.py add KEY VALUE [CATEGORY] | recall KEYWORD | summary
- Daily notes: python daily_notes.py today | auto | log "text"
- Error check: python check_errors.py (full stack check)
- Self-improve: python self_improve.py scan --save | propose
- Daily auto-runner: python auto_runner.py (health + performance + web research + AI proposal)
- Auto-runner runs automatically once per day at session start (flag in tasks/.auto_runner_YYYYMMDD)
- Daily plan: python tv_daily_plan.py (signals + levels + calendar + TV screenshots → http://localhost:3001/daily-plan)
- EOD review: python eod_review.py (today's trades → P&L + insight + notes — also auto-runs 10 PM UTC)
- **It trades. Stop opening sessions by asking why it doesn't.** This line used to
  read "one closed fill in its whole life, across 119 sessions" and stayed that way
  long after it stopped being true, and a stale sentence at the top of the boot file
  sets the agenda for every session that reads it: you conclude the thing is broken,
  go looking for the fault, find nothing wrong in the engine — because there is
  nothing wrong — and spend the session on the scaffolding instead.
  Measured 2026-08-18: **5 trades in 19 days, one every 3.8 days, ~96/year.** The
  same engine in replay does 914 trades over 4.2 years, ~218/year, so live is running
  at roughly half the replay rate — the right order of magnitude, not a fault.
  **Never quote a fill count from this file.** `node tasks/ai_brief.cjs` section 4
  counts the journal live. **This line used to name `GET /api/performance` as the
  other source of truth. THERE IS NO SUCH ROUTE** — corrected 2026-09-02 by
  `tasks/claims_check.cjs`. Only `/api/fleet-performance` (`index.js:10741`) and
  `/api/checksystem` (`:7010`) are registered, and line 334 of this same file already
  said the endpoint does not exist. The file contradicted itself and the wrong half
  was the half sending you to call it — a 404 that reads as a broken server rather
  than a wrong instruction.
  The sample is small because the system is WEEKS OLD, which is arithmetic, not a bug.
  Time fixes it and nothing else does — so the highest-value action is usually to
  change nothing and let it run.
- **Rejection ledger — how to get evidence without waiting.** The binding constraint
  is sample size, and every gate rejection is a fully priced paper trade, so the
  ledger manufactures evidence at zero risk. Read it before proposing ANY threshold
  change.
  - `GET /api/gate-health` — kill/pass counts per gate. Says a gate is FIRING.
  - `GET /api/rejection-evidence` — says whether it SHOULD have. Per gate:
    resolved, would-have-won %, net R, and a verdict of EARNING ITS KEEP /
    COSTING MONEY / NO MEASURABLE COST / TOO FEW TO JUDGE (floor 5 resolved).
  - MCP: `get_rejection_evidence`. Never merge it with `get_performance`.
  - Pipeline, already automated nightly by `tasks/auto_daily.bat`:
    `rejection_log.js` writes → `tasks/score_rr_rejections.py` walks each row
    forward on real broker bars → `tasks/learning_from_rejections.py` builds
    shadow stats. Contract: `tasks/REJECTION-LEDGER-SPEC.md` — read it first.
  - **These are forgone PAPER trades**: no spread, no slippage, entries never
    filled, fixed horizon. A screening signal for which gate to investigate, not
    realised P&L. **Where it contradicts a walk-forward, the walk-forward wins** —
    as of 2026-08-09 the ledger says MIN_RR rejections returned +7.14R over 22
    episodes while the 4-year sweep says lowering it costs 6.6R. Both are on
    record; neither has moved a setting.
  - **It must never change what trades.** No gate logic, no threshold, no signal
    admitted or suppressed. `feedsTheGate` is false everywhere and stays false.
- Price geometry (FVG / CRT / AMD): `server/fvg.js`, `server/structure.js`,
  `GET /api/fvg`. Matched-control screen: `node tasks/geometry_measure.cjs
  [--interval 1h]`. Bias x execution timeframes: `node tasks/crt_amd_mtf_measure.cjs`.
  **None of the three feeds confidence or sizing, and none of them should.**
  - **FVG has NO edge** — 6.9pp worse than random over ~6,800 samples. Context only.
  - **CRT is CLOSED as an engine input.** The cost walk-forward this file used to ask
    for RAN on 2026-08-09: 15/15 out-of-sample folds positive gross, break-even $2.95
    on Gold and 3.68pts on SPX, BTC dead at 2.1%. It then failed TWICE as an engine
    input — as a setup (0/5 folds, and it DISPLACED 16 Gold trades) and as a
    confidence contributor (SPX worse at every window). **Six measurements, six
    negatives. Do not re-open it, and do not re-run the cost walk-forward it already
    passed.** Its STANDALONE record stands and is a different question.
  - **AMD: the timestamp blocker is GONE.** This file claimed for weeks that AMD was
    "unmeasurable until the bridge sends bar timestamps" and carried
    `sessionAligned:false`. Verified 2026-08-27: the bridge sends `times` on d1, h4,
    h1 AND m15, 0 malformed, correct 14400s/900s steps, and `detectAMD` returns
    **`sessionAligned: true`** on all twelve series. The REAL blocker is that the
    pattern is near-absent — Gold finds 0 at d1/h4/h1, SPX 0 at h4, BTC 1 at h4;
    even m15 gives 4–9 over 4000 bars. Not measurable, for a different reason.
  - **4H bias with 15m execution: measured, and 15m is NOT best.** 1H execution beats
    it on 2 of 3 assets; on Gold plain h4->h4 is far the strongest. But EVERY 4H cell
    is UNDERPOWERED — broker history is only ~42–62 days of m15 and ~66–93 of h4,
    while 5 folds need >=40 trades and the richest cell has 26. **The binding limit is
    m15 HISTORY (the bridge ships 4000 bars), not the harness.**
- **AI Brain page = the control surface.** `GET /api/evidence-board` (what the
  system KNOWS vs assumes — every claim carries its verdict, evidence, caveat and
  **what would change the answer**, joined to live gate verdicts) and
  `GET /api/ai-registry` (skills, agents and MCP tools each tagged
  read-only / writes / **TRADES**, plus the guardrails marked ENFORCED IN CODE vs
  PROCEDURAL — counts are live, never quote them from memory). Curated claims live in
  `server/evidence_register.js` — **update it whenever something is measured**, or the
  board goes stale and starts lying.
  Reading surfaces only: nothing there runs a skill, spawns an agent or calls a tool.
- **The fleet is two boxes, and a page that shows one is not a status page.**
  `GET /api/system-plan` (this box beside the peer: health, gate, breaker, bridges,
  config source, engine parity, check-ins, plus action items that CAN clear and
  standing notes that are true-but-accepted) and `GET /api/fleet` (what is armed per
  account per box, settings compared field by field, both AI-employee ledgers). Both
  session-gated. Config lives in each machine's `keys.env`, which is gitignored:
  - Laptop: `PEER_SERVER_URL=http://169.58.74.133:3001` — it pulls and compares.
  - VPS: `PEER_HEARTBEAT_EXPECT=THEMIS` — the laptop cannot be reached from outside,
    so the only signal it is alive is its own 5-minute push. Silent >15 min is a
    high action item there. See [[peer_heartbeat_was_401_for_a_week]].
  **An action item that cannot clear is worse than none** — it trains you to skim past
  the one that matters. Every item must state the condition that retires it; anything
  permanent belongs in standing notes.
- **The gate funnel dies at CONFIDENCE, and that is why 6 of 10 gates look silent.**
  Verified 2026-08-09: MIN_RR killed 3 / passed 11, CONFIDENCE killed 5 / **passed 1**.
  `ENTRY_RSI` is disarmed by config (`minEntryRsi: 0`) and only counts passes while
  armed, by design. `COHORT_FLOOR` only records when a setup CLEARS the global gate
  then dies on a higher cohort floor — nothing gets near 70, so it never decides.
  The bridge gates fire only on a real trade attempt, so they are silent on the
  laptop and NOT on the VPS, which has `MAX_POSITIONS` evidence. **None of the ten
  gates is broken.** Do not "fix" them.
- **Run `node tasks/vps_parity.cjs` after ANY deploy, and before trusting a number
  that pools both boxes.** It answers the one question hand-patching cannot: do the
  two boxes run the same engine? Compares the 11 engine functions, 7 behavioural
  constants, the route surface and 16 tracked files, with line endings normalised
  and `strategy_settings.json` excluded (per-machine BY DESIGN). Exit 2 = engines
  diverge. The VPS carries commits this repo has never seen, so `index.js` is
  PATCHED not copied — on 2026-08-09 that took SEVEN hand-written patches and left
  nine `.bak-*` files, and nothing verified the result until this existed.
  **Re-run 2026-08-23 after eleven commits of deploys: ENGINES AGREE** — 11/11 engine
  functions, 7/7 constants, 101/101 routes. The `server/cohort_table.js` gap this line
  used to report is CLOSED: the file is present on the VPS and its `index.js` requires
  it, as it does `near_miss.js` and `python_path.js`. That gap was real on 2026-08-09
  and stopped being real some time before 2026-08-23 — **a fixed problem left standing
  in this file sends the next session hunting something that is not there**, which is
  the same failure as the fill-count line above.
  A full file-presence diff the same day: the VPS lacks exactly FIVE files and not one
  is a feature — `bridge_tags.ps1` (its logic is inline there; one account),
  `deploy_vps_catchup.ps1` (runs FROM the laptop TO the VPS), and three laptop-only
  utilities. **The VPS runs MORE automation than the laptop, not less**: 12 scheduled
  tasks it alone has, including the strategy search, against 6 that are laptop-only and
  each meaningless on a headless box. The two boxes differ in SCHEDULE, not in code.
  See [[vps_parity_check]] and [[dead_cohorts_are_why_it_never_trades]].
  Listing files over `ssh -EncodedCommand` returns CLIXML once the output is large and
  reads as "the VPS has 2 files" — write the list to a file there and `scp` it back.
- **Never restart a bridge by hand — use `node tasks/safe_bridge_restart.cjs`.**
  Default is REFUSE. It checks the server is up, trading is not halted, the bridge
  is currently reporting, **every open position has a broker-side SL**, and that no
  position is large enough to be partial-closed — then requires an explicit
  `--allow-open-positions` if any trade is open. `--dry-run` first, always.
  Why it matters: `position_partial_taken` (mt5_bridge.py:129) is IN-MEMORY and not
  persisted, so a restart forgets which trades already took 50% at 1R. At the fixed
  0.01 sizing the partial is skipped by `volume_min` so it cannot bite — but that is
  a property of the LOT SIZE, not of the code, and it stops being true the moment
  sizing changes. The tool checks it rather than assuming it.
  Shutdown itself closes nothing (`mt5.shutdown(); sys.exit(0)`), and broker SL/TP
  stay live through the gap — a position is unmanaged for those seconds, never
  unprotected.
- Setup health: GET http://localhost:3001/api/setup-health (which setups to take or avoid today)
- Daily plan API: GET http://localhost:3001/api/daily-plan (structured JSON for all assets)
- TV screenshots: node tv_screenshot.cjs [--4h] [--symbol btc|gold|spx] → dashboard/screenshots/
