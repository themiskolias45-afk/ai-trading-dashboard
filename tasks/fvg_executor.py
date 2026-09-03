"""FVG CONTINUATION EXECUTOR -- turns the validated model into real orders.

The model has been measured to death: disp 1.0 / 8R / retest 80, +0.6655 net R per trade
after the measured broker spread, 5 folds of 5 on XAUUSD, BTCUSD and SP500, better in the
last 90 days than over the full window, and only 4% of its gross R in the top five rows.
tasks/fvg_runner.cjs finds those setups live and writes them to tasks/fvg_shadow.jsonl.
Nothing turned them into trades. This does.

WHY A SEPARATE PROCESS AND A SEPARATE MAGIC NUMBER
mt5_bridge.py executes the engine's own signals under magic 20250101. This runs under its
own magic so every order it places is attributable, so the engine's position accounting is
untouched, and so it can be stopped without touching the bridge. It never reads or writes
the engine's signal path, its settings, or its journal.

THE GUARDS, ALL OF WHICH REFUSE BY DEFAULT
  --execute required   dry run otherwise. Nothing is placed by simply running this.
  freshness            a setup older than one execution bar is DEAD. The model enters on
                       the retest bar; by the next bar the price it wanted is gone, and
                       filling late is a different trade from the one measured.
  halt respected       reads BOTH halt systems and fails closed on either: the circuit
                       breaker (/api/risk-status, three consecutive losses) AND the
                       dashboard kill switch (/api/mt5/control). They are separate state
                       in the server -- POST /api/mt5/control writes `tradingControl`,
                       which never reaches the risk-status payload -- so checking only one
                       left the kill switch reaching the bridges and not the executors.
  own position cap     at most MAX_OPEN positions under this magic, and never two on the
                       same symbol. Concurrency was never modelled in the backtest, so it
                       is bounded here rather than assumed away.
  spread sanity        the stop must be at least 3x the current spread, the same rule the
                       measurement applies. A stop inside the spread is not a trade.
  broker-side SL/TP    every order carries its stop and target with it, so a crash or a
                       restart cannot leave a position unprotected.

  python tasks/fvg_executor.py                 dry run, prints what it would do
  python tasks/fvg_executor.py --execute       places orders

Reads:  tasks/fvg_shadow.jsonl (append-only, written by the runner)
Writes: tasks/fvg_executed.jsonl (append-only) -- never modifies the shadow ledger, so the
        measurement record and the execution record cannot corrupt each other.
"""

import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed. Run: pip install MetaTrader5")
    sys.exit(1)

ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# One executor, either model. --model picks the ledger and the magic number, so the two
# strategies keep separate order attribution and separate execution records while sharing
# one guarded code path -- two copies of order-placing code is two places for a guard to
# go missing.
MODELS = {
    # max_age is ONE BAR OF THE MODEL'S OWN EXECUTION TIMEFRAME. FVG enters on a 15-minute
    # retest, so a setup is dead in 15 minutes. TK enters on a closed 4-hour bar and stays
    # valid for that bar. A shared 900s window would silently discard every TK setup 15
    # minutes after it appeared -- a guard that throws away the trades it is meant to
    # protect is worse than no guard.
    "fvg": {"shadow": "fvg_shadow.jsonl", "executed": "fvg_executed.jsonl",
            "magic": 20260902, "label": "FVG_CONTINUATION", "max_age": 900},
    "tk":  {"shadow": "tk_shadow.jsonl",  "executed": "tk_executed.jsonl",
            "magic": 20260903, "label": "TK_SWING_PULLBACK", "max_age": 14400},
    # CRT+FVG enters on an m15 retest, so its setup is dead in 900s like FVG
    # continuation -- the h4 sweep only chooses which gap is in play.
    "crt": {"shadow": "crt_shadow.jsonl", "executed": "crt_executed.jsonl",
            "magic": 20260904, "label": "CRT_FVG", "max_age": 900},
}
# Parsed against the MODELS table, not by comparing to one name. The first version read
# `"tk" if argv[i+1] == "tk" else "fvg"`, which silently ran the FVG model -- its ledger,
# its magic number -- for any other value. Adding a third model to that would have armed
# `--model crt` on the FVG ledger and nothing would have looked wrong.
if "--model" in sys.argv and sys.argv.index("--model") + 1 < len(sys.argv):
    _model_key = sys.argv[sys.argv.index("--model") + 1]
    if _model_key not in MODELS:
        print("unknown --model %r; known: %s" % (_model_key, ", ".join(sorted(MODELS))))
        sys.exit(2)
else:
    _model_key = "fvg"
_M = MODELS[_model_key]
# --shadow-file points the executor at a DIFFERENT ledger to read. It exists for one
# reason: this code path had never handled a real setup, and finding a bug in position
# sizing or order construction at the moment the first live setup appears is the worst
# possible time to find it. A rehearsal file lets the whole plan be printed -- lots, stop,
# target, every guard decision -- against a synthetic setup, without polluting the real
# append-only ledger, which nothing is permitted to delete.
#
# It changes only WHICH FILE IS READ. Every guard still applies, --execute is still
# required to place anything, and the default is the model's own ledger.
def _shadow_path():
    if "--shadow-file" in sys.argv and sys.argv.index("--shadow-file") + 1 < len(sys.argv):
        return os.path.abspath(sys.argv[sys.argv.index("--shadow-file") + 1])
    return os.path.join(ROOT, "tasks", _M["shadow"])


SHADOW     = _shadow_path()
# The executed ledger FOLLOWS the rehearsal file. Without this a rehearsal would write
# its rows into the real execution record, and the next genuine setup carrying that key
# would be skipped as "already executed" -- a rehearsal silently suppressing a real trade.
EXECUTED   = (os.path.splitext(SHADOW)[0] + ".executed.jsonl"
              if "--shadow-file" in sys.argv
              else os.path.join(ROOT, "tasks", _M["executed"]))
SERVER     = os.environ.get("SMARTENTRY_HOST", "http://localhost:3001")

MAGIC      = _M["magic"]       # this model's own orders, never the engine's 20250101
MAX_OPEN   = int(os.environ.get("FVG_MAX_OPEN", "2"))
# SIZING COMES FROM server/strategy_settings.json, THE SAME FILE THE DASHBOARD WRITES.
#
# It did not, until 2026-09-02. This executor hardcoded 0.15% and read neither
# `fixedLotSize` nor `maxLotSize`, so all three dashboard sizing controls were inert for
# every model it places -- while working normally for the engine's own bridge. The user
# changed fixedLotSize twice that day believing it governed sizing. For these models it
# governed nothing. That is precisely the failure CLAUDE.md names: a decoration shaped
# like a safety switch is worse than no switch, because you stop watching the thing it
# pretends to control.
#
# fixedLotSize > 0 means "use exactly this size", which is how the user caps risk while a
# model is unproven, and it MUST win over the risk calculation. maxLotSize is a hard
# ceiling applied after either path.
#
# Env still overrides, for rehearsals and for a deliberate one-off; the file is the
# default, not the other way round.
SETTINGS_PATH = os.path.join(ROOT, "server", "strategy_settings.json")


def load_sizing():
    """Returns (risk_pct, fixed_lot, max_lot, source). Never raises.

    On an unreadable or malformed file it falls back to the built-in defaults AND SAYS
    SO, because silently running on defaults while the saved config says something else
    is the exact bug that turned fixedLotSize 0.01 into full risk-based sizing on the VPS
    on 2026-08-02.
    """
    defaults = (0.15, 0.0, 10.0)
    try:
        with open(SETTINGS_PATH, encoding="utf-8-sig") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError) as e:
        return defaults + ("BUILT-IN DEFAULTS -- could not read strategy_settings.json (%s)" % e,)
    if not isinstance(cfg, dict):
        return defaults + ("BUILT-IN DEFAULTS -- strategy_settings.json is not an object",)

    def num(key, fallback):
        v = cfg.get(key, fallback)
        try:
            v = float(v)
        except (TypeError, ValueError):
            return fallback
        # A negative or non-finite value is corruption, not a configuration choice.
        return v if v == v and v not in (float("inf"), float("-inf")) and v >= 0 else fallback

    return (num("riskPercent", 0.15), num("fixedLotSize", 0.0), num("maxLotSize", 10.0),
            "strategy_settings.json")


_RISK_PCT_FILE, FIXED_LOT, MAX_LOT, SIZING_SOURCE = load_sizing()
RISK_PCT   = float(os.environ.get("FVG_RISK_PCT", str(_RISK_PCT_FILE)))   # % of equity per trade
MAX_AGE_S  = int(os.environ.get("FVG_MAX_AGE_S", str(_M["max_age"])))  # one bar of this model
MIN_STOP_SPREADS = 3.0

EXECUTE = "--execute" in sys.argv
VERBOSE = "--verbose" in sys.argv

ASSET_SYMBOL = {"gold": "XAUUSD", "btc": "BTCUSD", "spx": "SP500"}


def log(msg):
    print("[" + _model_key + "-exec] " + msg, flush=True)


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # Reported, never silently dropped: a ledger that quietly loses a row is
                # the failure this project keeps finding.
                log("corrupt row skipped: " + line[:80])
    return rows


def server_json(path):
    try:
        with urllib.request.urlopen(SERVER + path, timeout=6) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"_error": str(e)}


def trading_halted(account_key="A"):
    """True when EITHER halt system says stop, and TRUE ALSO when either cannot be read.

    THERE ARE TWO HALT SYSTEMS AND THIS READ ONLY ONE OF THEM UNTIL 2026-09-02.

      /api/risk-status   the CIRCUIT BREAKER -- consecutive losses, per account, pushed
                         up by the bridge. This is what was checked.
      /api/mt5/control   the DASHBOARD KILL SWITCH -- the human saying stop. Written by
                         POST /api/mt5/control, which sets `tradingControl` and NOTHING
                         else; `tradingControl` appears nowhere in recomputeRiskStatus or
                         in the /api/risk-status payload (verified by grep, server/index.js).

    So flipping Trading Control on the dashboard stopped the two mt5_bridge processes --
    which read /api/mt5/control at mt5_bridge.py:477 -- and left every executor running.
    On the day all three executors were armed that made the kill switch reach 2 of 5 order
    paths. A switch that stops some of them is worse than one that stops none, because you
    believe you are flat and may trade manually on top of positions that are still opening.

    Both are checked, both fail CLOSED. 'I could not check' is not 'it is fine' -- the
    control file itself follows the same rule server-side, where an unreadable
    trading_control.json is loaded as halted.
    """
    control = server_json("/api/mt5/control")
    if "_error" in control:
        log("cannot read mt5/control (" + control["_error"] + ") -- refusing to trade on an "
            "unknown kill-switch state")
        return True
    if control.get("halted"):
        log("DASHBOARD KILL SWITCH IS ON" + (" -- " + str(control.get("reason"))
                                             if control.get("reason") else ""))
        return True

    st = server_json("/api/risk-status")
    if "_error" in st:
        log("cannot read risk-status (" + st["_error"] + ") -- refusing to trade on an unknown halt state")
        return True
    if st.get("halted"):
        return True
    acct = (st.get("accounts") or {}).get(account_key) or {}
    return bool(acct.get("halted"))


# ── TRAILING LADDER FOR THIS MODEL'S OWN POSITIONS ──────────────────────────────────
#
# mt5_bridge.py trails the ENGINE's positions and skips everything else - `if p.magic !=
# MAGIC_NUMBER: continue` - so a TK_SWING_PULLBACK or FVG_CONTINUATION position was never
# trailed by anything. The operator asked for it on both, so the same ladder runs here for
# this model's own magic, and only for that.
#
# THE MATHS IS COPIED FROM mt5_bridge.ladder_stop_price DELIBERATELY, epsilon included.
# Two implementations of a stop calculation is two places for one to drift, so if the
# bridge's numbers ever change these must be changed with them.
#
# THE RISK DENOMINATOR COMES FROM THE LEDGER, NOT THE LIVE STOP. Initial R is
# |entry - ORIGINAL sl|, and the live sl is the value this function mutates - reading it
# would shrink R on every ratchet and walk the stop up far faster than the ladder intends.
# tasks/*_executed.jsonl records the entry and stop as placed, which is exactly that.
# A position with no ledger row is SKIPPED and said out loud: a guessed R is worse than
# no trail.
#
# EVERY GUARD THE BRIDGE HAS, KEPT:
#   - only this model's magic, never another caller's position
#   - only when armed (>= TRAIL_ARM_R), steps FLOORED so it locks only realised profit
#   - locked_r floored at 0.0, so an armed stop is never worse than breakeven
#   - clamped into the broker's legal stop zone before sending
#   - `improves` check - it can only ever move a stop in the protecting direction
#   - --execute required, so a dry run prints and touches nothing
TRAIL_ENABLED    = os.environ.get("TRAIL_LADDER_ENABLED", "0") == "1"
TRAIL_ARM_R      = float(os.environ.get("TRAIL_ARM_R", "1.0"))
TRAIL_STEP_R     = float(os.environ.get("TRAIL_STEP_R", "0.5"))
TRAIL_GIVEBACK_R = float(os.environ.get("TRAIL_GIVEBACK_R", "0.5"))


def ladder_stop_price(entry, risk, price, is_buy):
    """Where the ratchet says the stop belongs now. None below the arm level."""
    step_epsilon = 1e-9
    profit_r = (price - entry) / risk if is_buy else (entry - price) / risk
    if profit_r < TRAIL_ARM_R - step_epsilon:
        return None
    steps_taken = math.floor((profit_r - TRAIL_ARM_R) / TRAIL_STEP_R + step_epsilon)
    locked_r = steps_taken * TRAIL_STEP_R + TRAIL_ARM_R - TRAIL_GIVEBACK_R
    locked_r = max(locked_r, 0.0)      # never worse than breakeven once armed
    return entry + locked_r * risk if is_buy else entry - locked_r * risk


def manage_trailing(open_positions):
    """Ratchet stops on this model's own positions. Never widens one, never touches another
    caller's ticket, and does nothing at all without --execute."""
    if not TRAIL_ENABLED:
        return
    # Initial risk per ticket, taken from what was actually placed.
    placed = {}
    for row in read_jsonl(EXECUTED):
        t = row.get("ticket")
        if t and row.get("price") is not None and row.get("sl") is not None:
            placed[t] = (float(row["price"]), float(row["sl"]))

    for p in open_positions:
        if p.magic != MAGIC:
            continue
        rec = placed.get(p.ticket)
        if not rec:
            log("trail SKIP #%d -- no ledger row, initial R unknown" % p.ticket)
            continue
        entry, original_sl = rec
        risk = abs(entry - original_sl)
        if risk <= 0:
            log("trail SKIP #%d -- zero initial risk" % p.ticket)
            continue

        is_buy = (p.type == 0)
        target = ladder_stop_price(entry, risk, p.price_current, is_buy)
        if target is None:
            continue                                   # not armed yet

        info = mt5.symbol_info(p.symbol)
        if info is None:
            log("trail SKIP #%d -- symbol_info(%s) unavailable" % (p.ticket, p.symbol))
            continue
        point = info.point or 0.0
        # Clamp into the broker legal zone rather than sending a stop it will reject.
        stops_level = (getattr(info, "trade_stops_level", 0) or 0) * point
        if stops_level:
            limit = p.price_current - stops_level if is_buy else p.price_current + stops_level
            target = min(target, limit) if is_buy else max(target, limit)
        target = round(target, info.digits)

        cur = p.sl
        if cur == 0:
            improves = True                            # no protection at all - anything beats it
        elif is_buy:
            improves = target > cur + point
        else:
            improves = target < cur - point
        if not improves:
            continue

        locked_r = (target - entry) / risk if is_buy else (entry - target) / risk
        if not EXECUTE:
            log("DRY RUN would move SL #%d %s %s -> %s (locks %.2fR)"
                % (p.ticket, p.symbol, cur, target, locked_r))
            continue
        res = mt5.order_send({"action": mt5.TRADE_ACTION_SLTP, "position": p.ticket,
                              "symbol": p.symbol, "sl": target, "tp": p.tp, "magic": MAGIC})
        if res is None:
            log("SL update returned nothing for #%d (%s)" % (p.ticket, mt5.last_error()))
        elif res.retcode == mt5.TRADE_RETCODE_DONE:
            log("TRAILED #%d %s SL %s -> %s (locks %.2fR)"
                % (p.ticket, p.symbol, cur, target, locked_r))
        else:
            log("SL update REJECTED for #%d retcode=%s" % (p.ticket, res.retcode))


def main():
    setups = read_jsonl(SHADOW)
    done_keys = {r.get("key") for r in read_jsonl(EXECUTED)}
    now = time.time()

    fresh = []
    for s in setups:
        if s.get("key") in done_keys:
            continue
        seen = s.get("seenAt")
        if not seen:
            continue
        try:
            age = now - datetime.fromisoformat(seen.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if age > MAX_AGE_S:
            if VERBOSE:
                log("stale by %.0fs, skipping %s %s" % (age, s.get("symbol"), s.get("direction")))
            continue
        fresh.append(s)

    if not fresh:
        log("no fresh setups (%d in ledger, %d already executed)" % (len(setups), len(done_keys)))
        # BUT AN OPEN POSITION STILL NEEDS ITS STOP MANAGED. Returning here meant trailing
        # only ever ran on a cycle that also had a fresh setup - and once this model holds
        # something, MAX_OPEN means most cycles have none. The ladder would have been
        # switched on and still never moved a stop: decoration with a switch on it, which
        # is precisely what it was turned on to stop being.
        #
        # Caught by dry-running it rather than by reading the flow: the first run printed
        # "no fresh setups" and exited before MT5 was even opened.
        if TRAIL_ENABLED:
            trail_only()
        return 0

    if trading_halted():
        log("TRADING HALTED -- %d fresh setup(s) not placed" % len(fresh))
        return 0

    # PIN THE TERMINAL, DO NOT JUST DETECT THE WRONG ONE.
    #
    # A bare initialize() attaches to whichever terminal answers first. On a box running
    # two - this laptop has the bridge's install on 25446287 and a second in AppData on
    # 11581419, the VPS's account - that is a coin flip, and it landed on the wrong one
    # every time it was tested. Refusing at that point is safe but leaves the box unable
    # to trade at all, which is not the goal: each box is meant to trade its OWN account.
    #
    # mt5_bridge.py:1065 has solved this since 2026-08-01 with MT5_TERMINAL_PATH. Same
    # mechanism here, same env var, so a box already configured for its bridge needs no
    # new setting. Unset means the previous behaviour exactly.
    terminal_path = os.environ.get("MT5_TERMINAL_PATH", "").strip()
    init_ok = mt5.initialize(path=terminal_path) if terminal_path else mt5.initialize()
    if not init_ok:
        log("MT5 initialize failed%s: %s"
            % ((" for terminal %s" % terminal_path) if terminal_path else "", mt5.last_error()))
        return 1
    try:
        # WHICH ACCOUNT DID WE ACTUALLY ATTACH TO?
        #
        # mt5.initialize() with no arguments attaches to whichever terminal answers first.
        # That is fine on a box with one terminal and wrong on a box with two: this laptop
        # runs the bridge's terminal on 25446287 AND a second in AppData logged into
        # 11581419, which is the VPS's account. Demonstrated 2026-09-03 - a bare
        # initialize() from the laptop returned the VPS's eight positions.
        #
        # So without this check, the laptop's executors would place real orders on the
        # VPS's account: two boxes trading one account, MAX_OPEN counted separately on
        # each, and the same setup filled twice at double the intended risk. mt5_bridge.py
        # has had MT5_EXPECTED_LOGIN since 2026-08-01 for exactly this; the executors
        # never got it.
        #
        # This is not a brake on trading. Each box is meant to trade its OWN demo account,
        # and pinning is what lets both trade independently instead of colliding. Unset
        # means "not pinned" and behaves exactly as before, so no existing deployment
        # changes behaviour by upgrading.
        # The pin comes from the env if set, and otherwise FROM THE SERVER. The bridge on
        # this box already reports MT5_EXPECTED_LOGIN up on /api/risk-status, so the box
        # itself knows which account it owns - asking it means both machines are pinned
        # correctly with no scheduled task to edit on either, and a box that later changes
        # account cannot leave a stale literal behind in a task definition.
        expected_login = os.environ.get("MT5_EXPECTED_LOGIN", "").strip()
        if not expected_login:
            risk = server_json("/api/risk-status") or {}
            for _acct in (risk.get("accounts") or {}).values():
                pinned = ((_acct or {}).get("config") or {}).get("expectedLogin")
                if pinned:
                    expected_login = str(pinned).strip()
                    log("pin read from this box's bridge via /api/risk-status: %s" % expected_login)
                    break
        acct = mt5.account_info()
        if expected_login:
            actual = str(acct.login) if acct else "unknown"
            if actual != expected_login:
                log("REFUSING TO TRADE: attached to account %s but MT5_EXPECTED_LOGIN is %s. "
                    "A bare initialize() takes whichever terminal answers first, and placing "
                    "orders on another box's account would double-fill every setup. "
                    "Nothing was placed." % (actual, expected_login))
                return 2
            log("account %s matches MT5_EXPECTED_LOGIN" % actual)
        else:
            log("MT5_EXPECTED_LOGIN not set -- trading whichever terminal answered (%s). "
                "Pin it in this box's executor task to guarantee the right account."
                % (acct.login if acct else "unknown"))

        positions = mt5.positions_get() or []
        mine = [p for p in positions if p.magic == MAGIC]

        # Trail BEFORE considering new entries. Protecting an open position is the more
        # urgent job, and it must still happen on a cycle where MAX_OPEN stops any new
        # trade being placed - which is most cycles once this model holds something.
        # Wrapped so a fault in the ladder can never stop the executor placing trades:
        # this is an addition, and an addition must not take down what already worked.
        try:
            manage_trailing(positions)
        except Exception as exc:
            log("trailing failed (%s) -- entries unaffected" % exc)
        held_symbols = {p.symbol for p in mine}
        log("%d open under magic %d, %d fresh setup(s)" % (len(mine), MAGIC, len(fresh)))
        log("sizing from %s: riskPercent %.3f%%, fixedLotSize %.2f, maxLotSize %.2f, MAX_OPEN %d"
            % (SIZING_SOURCE, RISK_PCT, FIXED_LOT, MAX_LOT, MAX_OPEN))

        account = mt5.account_info()
        equity = account.equity if account else None

        for s in fresh:
            symbol = s.get("symbol") or ASSET_SYMBOL.get(s.get("asset"))
            direction = s.get("direction")
            entry, stop, target = s.get("entry"), s.get("stop"), s.get("target")
            tag = "%s %s" % (symbol, direction)

            if len(mine) >= MAX_OPEN:
                log("SKIP %s -- already at MAX_OPEN=%d for this model" % (tag, MAX_OPEN))
                continue
            if symbol in held_symbols:
                log("SKIP %s -- this model already holds %s" % (tag, symbol))
                continue
            if not mt5.symbol_select(symbol, True):
                log("SKIP %s -- symbol not available" % tag)
                continue

            info = mt5.symbol_info(symbol)
            tick = mt5.symbol_info_tick(symbol)
            if not info or not tick or not tick.bid or not tick.ask:
                log("SKIP %s -- no live quote" % tag)
                continue

            spread = tick.ask - tick.bid
            risk_dist = abs(entry - stop)
            if spread > 0 and risk_dist < MIN_STOP_SPREADS * spread:
                log("SKIP %s -- stop %.5f is under %gx the spread %.5f"
                    % (tag, risk_dist, MIN_STOP_SPREADS, spread))
                continue

            is_buy = direction == "BUY"
            price = tick.ask if is_buy else tick.bid
            # The model enters at the FVG edge. If price has already run past the stop
            # side, the setup is gone -- filling here is a worse trade than the one
            # measured, not the same one late.
            if (is_buy and price <= stop) or (not is_buy and price >= stop):
                log("SKIP %s -- price %.5f is already through the stop %.5f" % (tag, price, stop))
                continue

            lots = None
            # fixedLotSize wins outright. It is the user's cap on an unproven model and a
            # risk calculation that quietly overrides it is not a smaller bug for being
            # arithmetically correct.
            if FIXED_LOT > 0:
                lots = FIXED_LOT
            elif equity and risk_dist > 0:
                tick_value = info.trade_tick_value or 0
                tick_size = info.trade_tick_size or 0
                if tick_value > 0 and tick_size > 0:
                    value_per_unit = (risk_dist / tick_size) * tick_value
                    if value_per_unit > 0:
                        lots = (equity * RISK_PCT / 100.0) / value_per_unit
            if lots is None:
                log("SKIP %s -- cannot size the position from this symbol's tick data" % tag)
                continue
            step = info.volume_step or 0.01
            # The configured ceiling is applied ALONGSIDE the broker's, not instead of it.
            ceiling = min(info.volume_max, MAX_LOT) if MAX_LOT > 0 else info.volume_max
            requested = lots
            lots = max(info.volume_min, min(ceiling, round(lots / step) * step))
            lots = round(lots, 2)
            if requested > ceiling:
                log("CAPPED %s -- %.2f lots requested, ceiling %.2f (maxLotSize %.2f, "
                    "broker max %.2f)" % (tag, requested, ceiling, MAX_LOT, info.volume_max))
            if lots > requested:
                # volume_min forced the size UP past what was asked for. Reported in BOTH
                # sizing modes, not just the risk-based one. Measured 2026-09-02: with
                # fixedLotSize 0.01 the executor plans 0.10 lots on SP500, because that is
                # the broker's minimum there -- the configured cap becomes 10x on that one
                # instrument, silently. A cap that a single symbol quietly multiplies is
                # the kind of thing an operator must be told, not left to find in the P&L.
                if FIXED_LOT > 0:
                    log("OVERSIZED %s -- fixedLotSize is %.2f but the broker minimum on "
                        "this symbol is %.2f, so it is %.1fx the configured size"
                        % (tag, FIXED_LOT, lots, lots / FIXED_LOT if FIXED_LOT else 0))
                else:
                    log("OVERSIZED %s -- risk budget wanted %.4f lots, broker minimum is "
                        "%.2f, so this trade risks MORE than %.2f%%"
                        % (tag, requested, lots, RISK_PCT))

            plan = ("%s %.2f lots @ %.5f  SL %.5f  TP %.5f  risk %.2f%%"
                    % (tag, lots, price, stop, target, RISK_PCT))
            if not EXECUTE:
                log("DRY RUN would place: " + plan)
                # Count it. Without this a dry run prints a plan for EVERY fresh setup
                # while a live run would stop at MAX_OPEN, so the rehearsal overstates
                # what actually happens -- a dry run that does not model the guard it is
                # rehearsing is not a rehearsal.
                mine.append(type("P", (), {"symbol": symbol, "magic": MAGIC})())
                held_symbols.add(symbol)
                continue

            request = {
                "action":       mt5.TRADE_ACTION_DEAL,
                "symbol":       symbol,
                "volume":       lots,
                "type":         mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL,
                "price":        price,
                "sl":           float(stop),
                "tp":           float(target),
                "deviation":    20,
                "magic":        MAGIC,
                "comment":      _M["label"][:16],
                "type_time":    mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }
            result = mt5.order_send(request)
            ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
            log(("PLACED " if ok else "REJECTED ") + plan
                + ("  ticket %s" % result.order if ok else "  retcode %s" % (result.retcode if result else "none")))

            # Recorded either way. A rejected order that leaves no trace is how the same
            # setup gets retried forever.
            with open(EXECUTED, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "key": s.get("key"), "at": datetime.now(timezone.utc).isoformat(),
                    "symbol": symbol, "direction": direction, "lots": lots,
                    "price": price, "sl": stop, "tp": target, "magic": MAGIC,
                    "placed": ok,
                    "retcode": (result.retcode if result else None),
                    "ticket": (result.order if ok else None),
                    "model": _M["label"],
                }) + "\n")
            if ok:
                mine.append(type("P", (), {"symbol": symbol, "magic": MAGIC})())
                held_symbols.add(symbol)
    finally:
        mt5.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
