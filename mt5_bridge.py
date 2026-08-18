"""
SmartEntry MT5 Bridge v1
Polls SmartEntry Pro signals and executes trades on MetaTrader 5.

Requirements:
    pip install MetaTrader5 requests colorama

Usage:
    python mt5_bridge.py           # semi-auto (confirm each trade)
    python mt5_bridge.py --auto    # full-auto (execute STRONG signals instantly)
"""

import sys
import os
import time
import json
import math
import threading
import requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

# Force UTF-8 stdout/stderr regardless of how this process is launched — Task
# Scheduler and some non-console launch paths fall back to the system's legacy
# codepage (cp1252 on Windows), which can't encode characters like the arrow
# used in log lines below and crashes the whole bridge on the very first log call.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERROR: MetaTrader5 not installed. Run: pip install MetaTrader5")
    sys.exit(1)

try:
    from colorama import init, Fore, Style
    init(autoreset=True)
    GREEN  = Fore.GREEN
    RED    = Fore.RED
    YELLOW = Fore.YELLOW
    CYAN   = Fore.CYAN
    BOLD   = Style.BRIGHT
    RESET  = Style.RESET_ALL
except ImportError:
    GREEN = RED = YELLOW = CYAN = BOLD = RESET = ""

# ── Configuration ─────────────────────────────────────────────────────────────
SERVER_URL     = os.environ.get("SMARTENTRY_URL", "http://localhost:3001")
RISK_PERCENT   = float(os.environ.get("RISK_PERCENT", "1.0"))   # % of balance per trade
MAX_SPREAD_PTS = int(os.environ.get("MAX_SPREAD",    "50"))      # reject trade if spread > this


def max_spread_for(symbol):
    """Spread cap for one symbol, falling back to the global MAX_SPREAD.

    A single points cap cannot work across instruments with different tick sizes
    and price scales. On the VPS's Vantage feed a normal BTCUSD spread of ~$17
    reads as ~1700 ticks while XAUUSD is 22 and SP500 is 36, so a cap tuned for
    metals silently made BTC untradeable - every attempt was skipped at the gate
    before an order was ever sent, which looks identical to "no signal fired".

    Override per symbol with MAX_SPREAD_BTCUSD, MAX_SPREAD_XAUUSD, etc. Unset
    means the global value, so behaviour is unchanged wherever no override exists.
    """
    raw = os.environ.get("MAX_SPREAD_" + symbol.upper())
    if raw is None or raw.strip() == "":
        return MAX_SPREAD_PTS
    try:
        value = int(raw)
    except ValueError:
        log(f"MAX_SPREAD_{symbol.upper()}={raw!r} is not an integer - "
            f"falling back to global {MAX_SPREAD_PTS}", YELLOW)
        return MAX_SPREAD_PTS
    if value <= 0:
        log(f"MAX_SPREAD_{symbol.upper()}={value} is not positive - "
            f"falling back to global {MAX_SPREAD_PTS}", YELLOW)
        return MAX_SPREAD_PTS
    return value
POLL_INTERVAL  = int(os.environ.get("POLL_INTERVAL", "60"))      # seconds between signal checks
MAGIC_NUMBER   = 20250101                                         # unique ID for SmartEntry orders
AUTO_MODE      = "--auto" in sys.argv
TERMINAL_PATH  = os.environ.get("MT5_TERMINAL_PATH", "")          # pin to one MT5 install when running multiple terminals
ACCOUNT_TAG    = os.environ.get("ACCOUNT_TAG", "")                # identifies this instance in logs + server posts (dual-account setups)

# Refuse to trade unless the connected terminal holds this exact login.
#
# MT5_TERMINAL_PATH pins a bridge to one *install*, which is not the same as
# pinning it to one *account*. Two terminals can hold the same login, and if they
# do, both bridges poll the same signals and both execute against the same
# account: every trade placed twice, at double the intended risk. That is not
# redundancy, it is accidental 2x leverage, and nothing in this file used to
# prevent it — the mirrored dual-account setup only ever worked because the two
# terminals happened to hold different accounts.
#
# Leave unset to keep the old behaviour (connect to whatever the terminal holds).
# Set it per bridge and a mis-pointed terminal fails loudly at startup instead of
# silently doubling exposure.
EXPECTED_LOGIN = os.environ.get("MT5_EXPECTED_LOGIN", "").strip()

# MT5 symbol map: SmartEntry Yahoo ticker → candidate MT5 symbol names (checked in order)
SYMBOL_CANDIDATES = {
    "BTC-USD": ["BTCUSD", "BTC/USD", "BITCOIN", "BTCUSDT"],
    "GC=F":    ["XAUUSD", "GOLD", "XAUUSDm", "GOLDm"],
    "^GSPC":   ["SP500", "US500", "SPX500", "US.500", "SPY"],
}

# Assets AUTO mode may open positions on. All three trade.
#
# Kept as one named tuple rather than three hardcoded submit() calls so an asset
# can be taken out later by editing this line alone. Worth knowing when that day
# comes: replayed through generateSignalMTF - the live multi-timeframe path, not
# the single-timeframe replay the standard harness runs - SPX scores PF 0.32 over
# the full sample and 0.00 on the held-out test half. It trades anyway; the
# learning engine cannot calibrate on an asset it never sees closed trades from.
TRADABLE_KEYS = ("btc", "gold", "spx")

# Resolved at startup by auto_detect_symbols()
SYMBOL_MAP = {}

# Minimum lots per symbol (broker-specific — auto-detected at startup)
MIN_LOT = {}

# ── State ─────────────────────────────────────────────────────────────────────
executed_signals  = {}   # key → signal updatedAt string (deduplication)
known_positions   = set()  # set of open SmartEntry position tickets
position_initial_r = {}  # ticket → initial risk (|entry - original_sl|) for trailing stop logic
position_partial_taken = set()  # tickets where 50% has already been closed at 1R

# ── Trailing stop ladder ──────────────────────────────────────────────────────
# Once a trade reaches TRAIL_ARM_R in profit, the stop ratchets up behind price in
# TRAIL_STEP_R increments, always TRAIL_GIVEBACK_R behind the step it is locking:
#
#   profit 1.0R → SL at entry + 0.5R
#   profit 1.5R → SL at entry + 1.0R
#   profit 2.0R → SL at entry + 1.5R   …and so on, in 0.5R steps.
#
# THE LADDER IS OFF, AND THAT IS THE MEASURED ANSWER.
#
# It was promoted on 2026-08-07 on one in-sample run at give-back 1.0, then moved to
# 0.5 when five out-of-sample folds made 0.5 look ROBUST at 5/5. A pre-registered
# re-test at DIFFERENT fold boundaries killed it the same day:
#
#   give-back   5 folds        7 folds                4 folds
#   off         4/5 one neg    6/7 one neg            4/4 NONE neg  ROBUST
#   0.5         5/5 none neg   5/7 two neg (-0.275,   2/4 two neg   UNSTABLE
#                              -0.028)                (-0.036, -0.139)
#   1.0         4/5 one neg    6/7                    2/4           UNSTABLE
#   1.5         4/5 one neg    5/7                    3/4
#
# 0.5 went negative in FOUR folds across the two re-cuts. Its 5/5 was the cut, not
# the edge: one window carried it every single time (+0.797 at 5 folds, +1.247 at 7,
# +0.720 at 4). `off` is the only setting that is never negative under any scheme,
# and it is ROBUST at 4 folds.
#
# The pre-registered rule said revert to `off` on a single negative fold. It got
# four. Total R still favours 0.5 (+61.9 vs +28.2) and that is exactly the number
# not to trade on — it comes from more trades and one lucky window, while the
# per-fold stability that the promotion bar actually tests fails.
#
# What OFF means: the stop never moves. No breakeven, no ratchet. A trade at +3R can
# give all of it back to its original stop. Five years of held-out data say that is
# net better than any give-back tried, because capping the runners costs more than
# the give-back saves.
#
# Set TRAIL_LADDER_ENABLED=1 to turn it back on, and re-measure at more than one
# fold count before believing any result.
TRAIL_LADDER_ENABLED = os.environ.get("TRAIL_LADDER_ENABLED", "0") == "1"
TRAIL_ARM_R      = float(os.environ.get("TRAIL_ARM_R", "1.0"))      # profit needed before the stop moves at all
TRAIL_STEP_R     = float(os.environ.get("TRAIL_STEP_R", "0.5"))     # granularity of each ratchet step
TRAIL_GIVEBACK_R = float(os.environ.get("TRAIL_GIVEBACK_R", "0.5")) # how far behind price the stop sits

# Where each position's TRUE initial risk survives a restart.
#
# This existed only in the in-memory dict above, and was re-derived on every start
# from the position's CURRENT stop — the very value manage_trailing_stops mutates.
# So the moment a stop moved, by this code or by hand, the next restart recorded a
# corrupted "initial risk", and this bridge restarts dozens of times a day. Two
# measured failure modes on 2026-08-07, both silent:
#
#   • after a move to breakeven, sl == entry → r = 0 → `if r > 0` fails → the
#     ticket is never recorded and every later poll hits `continue`. Trailing is
#     dead for the rest of that position's life, with nothing logged.
#   • Gold #1713655080, stop moved by hand to 4276.25 → r re-derived as 34.52
#     instead of 75.69, which put the stop at exactly the fake `entry + 1R`. The
#     ladder condition could then never be true again. Frozen at +83 while price
#     ran 30 points past the real 1R trigger.
#
# One file per account tag, matching BREAKER_STATE_PATH, because each bridge keeps
# its own books.
POSITION_R_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "tasks",
    f"position_r_{ACCOUNT_TAG or 'default'}.json",
)

# Tickets already reported as having no recoverable R, so the warning below is loud
# once per position rather than once per 60s poll forever.
trail_unresolved_logged = set()
# Tickets already reported as too small to take a partial on. Same reasoning.
partial_too_small_logged = set()

# ── Risk circuit breaker ───────────────────────────────────────
daily_pnl        = 0.0      # cumulative P&L today
daily_loss_limit = float(os.environ.get("DAILY_LOSS_PCT", "3.0"))  # % of balance
consecutive_losses = 0
MAX_CONSECUTIVE_LOSSES = int(os.environ.get("MAX_CONSEC_LOSSES", "3"))
trading_halted   = False
halt_reason      = ""

# When the current halt was set, and WHICH breaker set it. Both are persisted.
#
# The streak breaker used to have no exit. consecutive_losses resets in exactly one
# place — a winning close — and the halt blocks the entries that could produce one, so
# once every open position closed with the streak at the cap, no trade could open, no
# win could occur, and the streak could never clear. The box stayed dead until a human
# noticed, and the box that trades continuously is headless.
#
# halt_cause separates the two breakers because only ONE of them is wedged like that.
# A daily-loss halt already expires when the day rolls over (see load_breaker_state);
# a streak halt does not, by design, because the streak itself survives the day.
halted_at        = ""       # ISO-8601 Z, "" when not halted
halt_cause       = ""       # HALT_CAUSE_STREAK | HALT_CAUSE_DAILY_LOSS | ""

HALT_CAUSE_STREAK      = "STREAK"
HALT_CAUSE_DAILY_LOSS  = "DAILY_LOSS"

# How long a STREAK halt stands before the bridge releases itself.
#
# 48h rather than the conventional 24h because this system averages well under a trade
# a day — a 24h box could serve its whole cooldown without a single signal, which makes
# the pause a formality rather than a pause. Set HALT_COOLDOWN_HOURS to change it; 0
# disables the release entirely and restores the old human-only behaviour.
HALT_COOLDOWN_HOURS = float(os.environ.get("HALT_COOLDOWN_HOURS", "48"))

# The release DECAYS the streak instead of clearing it. A clean slate would hand full
# confidence back to a system that had just lost MAX_CONSECUTIVE_LOSSES in a row, which
# is precisely when it has least earned it. Coming back one loss short of the cap means
# a genuinely broken system re-halts on its very next loss, while a system that hit a
# bad patch gets to prove itself on a single trade.
HALT_RELEASE_DECAY = 1

# Where the breaker's counters survive a restart.
#
# They used to live only in the globals above, so every bridge start silently reset
# the loss streak to zero. Two restarts in a day is normal here (watchdog, startup
# scripts), which meant "3 consecutive losses" could not accumulate in practice —
# the guardrail existed in config and nowhere else. Ticket #1682651222 proved the
# other half of it: that loss closed while the bridge was down, reached the journal
# and the learning engine, and never reached the breaker at all.
#
# One file per account tag, because each bridge halts its own execution and must
# keep its own books. This deliberately does NOT solve two MACHINES sharing one
# broker account — their state files sit on different disks and neither can see
# the other's losses.
BREAKER_STATE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "tasks",
    f"breaker_state_{ACCOUNT_TAG or 'default'}.json",
)

# Close time of the most recent trade already folded into the counters above.
# Startup reconciliation uses it to count only what it has not counted before.
last_counted_close = ""


def breaker_day():
    """Local date the daily P&L counter is scoped to.

    Local rather than UTC because close times come from datetime.fromtimestamp(),
    which is local — scoping the counter in one zone and stamping the outcomes in
    another would misfile every close in the offset window.
    """
    return datetime.now().strftime("%Y-%m-%d")


def load_breaker_state():
    """Restore the breaker counters from the previous run.

    Fails open by design: an unreadable or corrupt file starts the bridge clean
    rather than wedged, because a file that cannot be parsed is not evidence of a
    loss streak. It is logged loudly so the failure is never silent.
    """
    global daily_pnl, consecutive_losses, trading_halted, halt_reason, last_counted_close
    global halted_at, halt_cause
    try:
        with open(BREAKER_STATE_PATH, "r", encoding="utf-8") as state_file:
            state = json.load(state_file)
    except FileNotFoundError:
        return
    except Exception as exc:
        log(f"Breaker state unreadable ({exc}) — starting with clean counters.", YELLOW)
        return

    # A streak is a streak, not a daily counter: it carries across days and restarts
    # until a WIN clears it. Daily P&L is the opposite — scoped to one day, and
    # dragging yesterday's losses into today's loss limit would halt on a day that
    # never lost anything.
    consecutive_losses = int(state.get("consecutiveLosses", 0) or 0)
    last_counted_close = str(state.get("lastCountedClose", "") or "")
    trading_halted     = bool(state.get("halted", False))
    halt_reason        = str(state.get("haltReason", "") or "")
    halt_cause         = str(state.get("haltCause", "") or "")
    halted_at          = str(state.get("haltedAt", "") or "")

    # A state file written before haltedAt existed carries a halt with no clock on it.
    # Reading that as epoch-zero would release it the instant this bridge starts, which
    # turns an upgrade into an unannounced resumption of trading. Stamp it NOW instead,
    # so a legacy halt serves a full cooldown from the upgrade rather than none.
    if trading_halted and not halted_at:
        halted_at = datetime.utcnow().isoformat() + "Z"
        log("Halt on disk predates the cooldown clock — starting it from now, "
            f"not releasing early ({HALT_COOLDOWN_HOURS:.0f}h from this moment).", YELLOW)
    # Same reasoning for the cause: an unlabelled halt is treated as a STREAK halt only
    # when the streak actually justifies one. Otherwise it is left unlabelled and the
    # timer will not touch it, because guessing wrong here releases a daily-loss halt.
    if trading_halted and not halt_cause and consecutive_losses >= MAX_CONSECUTIVE_LOSSES:
        halt_cause = HALT_CAUSE_STREAK

    if state.get("day") == breaker_day():
        daily_pnl = float(state.get("dailyPnl", 0.0) or 0.0)
    else:
        daily_pnl = 0.0
        # A halt scoped to yesterday's daily loss limit expires with that day. A halt
        # caused by the loss streak does not, because the streak itself survives.
        if trading_halted and consecutive_losses < MAX_CONSECUTIVE_LOSSES:
            trading_halted = False
            halt_reason    = ""
            halted_at      = ""
            halt_cause     = ""

    # The banner names the cooldown too. A restarted bridge that says only "halted True"
    # leaves whoever reads it unable to tell a pause from a permanent stop.
    left = halt_cooldown_remaining_seconds()
    when = f", releases in {left / 3600:.1f}h" if left is not None else ""
    log(f"Breaker state restored: streak {consecutive_losses}/{MAX_CONSECUTIVE_LOSSES}, "
        f"daily P&L ${daily_pnl:.2f}, halted {trading_halted}"
        + (f" ({halt_cause})" if halt_cause else "") + when, CYAN)


def save_breaker_state():
    """Persist the breaker counters. Never raises — a write failure must not stop trading."""
    try:
        os.makedirs(os.path.dirname(BREAKER_STATE_PATH), exist_ok=True)
        with open(BREAKER_STATE_PATH, "w", encoding="utf-8") as state_file:
            json.dump({
                "account":           ACCOUNT_TAG or "default",
                "day":               breaker_day(),
                "dailyPnl":          round(daily_pnl, 2),
                "consecutiveLosses": consecutive_losses,
                "halted":            trading_halted,
                "haltReason":        halt_reason,
                # Without these two the cooldown cannot survive a restart, and a
                # restart is the most likely thing to happen during one.
                "haltedAt":          halted_at,
                "haltCause":         halt_cause,
                "lastCountedClose":  last_counted_close,
                "updatedAt":         datetime.utcnow().isoformat() + "Z",
            }, state_file, indent=2)
    except Exception as exc:
        log(f"Could not persist breaker state ({exc}) — counters are memory-only this run.", YELLOW)


def record_closed_outcome(pnl, close_time):
    """Fold one closed trade into the breaker counters and persist the result.

    Single entry point so the live close path and startup reconciliation cannot
    drift apart, and so no counter change is left only in memory. A null P&L is
    ignored rather than treated as a win: an outcome nobody could measure must not
    be allowed to clear a loss streak.

    The breaker is evaluated HERE, in the same moment the counters move, not left
    to whenever a signal next tries to open a trade. check_circuit_breaker() had
    exactly one call site — the open-a-trade path — so between a losing close and
    the next signal the box reported halted:false while already standing at its
    limit. On 2026-08-18 the VPS sat at 3 consecutive losses of 3 with halted:false
    on /api/risk-status, the dashboard, the doctor and the fleet view, all three
    assets WAIT, and nothing due to run that would have corrected it. The next real
    signal would have halted correctly; every human and automated reader in between
    saw "trading is live" for a box that was breaker-tripped in all but name.
    """
    global daily_pnl, consecutive_losses, last_counted_close
    if pnl is None:
        return
    # P&L counts against the day it actually happened on. A close recovered from an
    # outage that spanned midnight must still move the streak, but must not spend
    # today's loss budget on yesterday's loss. An unknown close time is treated as
    # today, which is the conservative reading.
    if not close_time or close_time[:10] == breaker_day():
        daily_pnl += pnl
    if pnl < 0:
        consecutive_losses += 1
    else:
        consecutive_losses = 0
    if close_time and close_time > last_counted_close:
        last_counted_close = close_time
    save_breaker_state()
    # Counters on disk FIRST, then the verdict — check_circuit_breaker() persists
    # again if it trips, so the halt flag can never land without the streak that
    # caused it. Safe to call from here: it is idempotent (early return while
    # already halted), it returns False rather than raising when MT5 is
    # unreachable, and it can only ever SET the halt, never clear one. Nothing
    # that was blocked before becomes permitted by calling it sooner.
    check_circuit_breaker()

# ── Helpers ───────────────────────────────────────────────────────────────────

# Remote halt set from the dashboard. Separate from the local circuit breakers
# because the two mean different things: a circuit breaker is the bridge deciding
# it has lost enough for today, a remote halt is a human deciding to stop.
# Reported separately too, so "why is nothing trading" always has a clear answer.
remote_halted = False
remote_halt_reason = ""


def check_remote_control():
    """Poll the server's kill switch. Returns True when trading is remotely halted.

    Deliberately fail-OPEN on a network error: the server being briefly
    unreachable is not an instruction to stop, and the local circuit breakers
    still protect the account. A halt that latches on every dropped packet would
    train you to ignore it.
    """
    global remote_halted, remote_halt_reason
    try:
        res = requests.get(f"{SERVER_URL}/api/mt5/control", timeout=5)
        res.raise_for_status()
        control = res.json()
        halted = bool(control.get("halted"))
        reason = control.get("reason") or "halted from dashboard"
        if halted and not remote_halted:
            log(f"REMOTE HALT: {reason} — will not open new trades.", RED + BOLD)
        elif not halted and remote_halted:
            log("Remote halt lifted — trading enabled again.", GREEN)
        remote_halted = halted
        remote_halt_reason = reason if halted else ""
        return remote_halted
    except Exception as exc:
        log(f"Could not read remote control ({exc}) — leaving trading as-is.", YELLOW)
        return remote_halted


def halt_cooldown_remaining_seconds():
    """Seconds left on the current STREAK halt's cooldown, or None if none applies.

    None means the timer has nothing to say — not halted, not a streak halt, the
    release disabled, or the timestamp unreadable. A corrupt timestamp deliberately
    reads as "no opinion" rather than "release now": failing open here would resume
    trading on a parse error.
    """
    if not trading_halted or halt_cause != HALT_CAUSE_STREAK:
        return None
    if HALT_COOLDOWN_HOURS <= 0:
        return None
    if not halted_at:
        return None
    try:
        started = datetime.fromisoformat(halted_at.rstrip("Z"))
    except (ValueError, AttributeError) as exc:
        log(f"Halt timestamp unreadable ({exc}) — cooldown not applied, halt stands.", YELLOW)
        return None
    elapsed = (datetime.utcnow() - started).total_seconds()
    return max(0.0, HALT_COOLDOWN_HOURS * 3600 - elapsed)


def release_streak_halt_if_cooled():
    """Lift a STREAK halt that has served its cooldown, decaying the streak by one.

    This is the exit the streak breaker never had. It is deliberately narrow:

      - STREAK halts only. A daily-loss halt expires when the day rolls over, which
        load_breaker_state already handles; releasing one here would shorten a limit
        that is supposed to last the day.
      - remote_halted is never touched. That is a human deciding to stop, and a timer
        that could overrule a person is a worse bug than the one being fixed.
      - The streak DECAYS, it does not reset. Coming back at MAX-1 means a genuinely
        broken system re-halts on its very next loss.

    Returns True if a halt was released.
    """
    global trading_halted, halt_reason, halted_at, halt_cause, consecutive_losses
    remaining = halt_cooldown_remaining_seconds()
    if remaining is None or remaining > 0:
        return False
    was = consecutive_losses
    consecutive_losses = max(0, consecutive_losses - HALT_RELEASE_DECAY)
    trading_halted = False
    halt_reason    = ""
    halted_at      = ""
    halt_cause     = ""
    log(f"⏱ CIRCUIT BREAKER RELEASED after {HALT_COOLDOWN_HOURS:.0f}h — streak {was} "
        f"-> {consecutive_losses} of {MAX_CONSECUTIVE_LOSSES}. Trading resumes ONE loss "
        "short of halting again; this is a cooldown, not a clean slate.", YELLOW + BOLD)
    save_breaker_state()
    return True


def check_circuit_breaker():
    global trading_halted, halt_reason, halted_at, halt_cause
    # BEFORE the early return below, or the release is unreachable: the whole point is
    # that it applies while trading_halted is True.
    release_streak_halt_if_cooled()
    if trading_halted:
        return True

    # Consecutive losses FIRST, because this check needs no broker.
    #
    # It used to sit below the `if not acc: return False` guard, so a dead MT5 terminal
    # disabled the streak breaker entirely — and a dead terminal here is SILENT: every
    # call returns None and nothing raises, so the bridge looks healthy while its loss
    # guard is off. The streak is arithmetic on an in-memory counter that the close path
    # maintains; it never needed account_info() and must not depend on it. Only the
    # daily-loss test below genuinely needs a balance to divide by.
    if consecutive_losses >= MAX_CONSECUTIVE_LOSSES:
        trading_halted = True
        halt_reason = f"{consecutive_losses} consecutive losses — pausing"
        halted_at   = datetime.utcnow().isoformat() + "Z"
        halt_cause  = HALT_CAUSE_STREAK
        cooldown = (f" — releases in {HALT_COOLDOWN_HOURS:.0f}h at streak "
                    f"{max(0, consecutive_losses - HALT_RELEASE_DECAY)}"
                    if HALT_COOLDOWN_HOURS > 0 else " — no auto-release, needs a human")
        log(f"🛑 CIRCUIT BREAKER: {halt_reason}{cooldown}", RED + BOLD)
        # A halt that only exists in memory is undone by the next restart, which
        # is the same defect that made the streak unaccumulable.
        save_breaker_state()
        return True

    acc = mt5.account_info()
    if not acc:
        return False
    # Daily loss limit — needs the balance, so it stays behind the account gate.
    if acc.balance > 0:
        loss_pct = (-daily_pnl / acc.balance) * 100
        if loss_pct >= daily_loss_limit:
            trading_halted = True
            halt_reason = f"Daily loss limit hit: -{loss_pct:.1f}% (limit {daily_loss_limit}%)"
            halted_at   = datetime.utcnow().isoformat() + "Z"
            halt_cause  = HALT_CAUSE_DAILY_LOSS
            log(f"🛑 CIRCUIT BREAKER: {halt_reason}", RED + BOLD)
            save_breaker_state()
            return True
    return False


def log(msg, color=""):
    ts = datetime.now().strftime("%H:%M:%S")
    prefix = f"[{ACCOUNT_TAG}] " if ACCOUNT_TAG else ""
    print(f"{color}[{ts}] {prefix}{msg}{RESET}")


def fetch_signals():
    try:
        res = requests.get(f"{SERVER_URL}/api/signals", timeout=10)
        res.raise_for_status()
        return res.json()
    except Exception as e:
        log(f"Signal fetch failed: {e}", RED)
        return None


# ── Universal rejection ledger (client) ───────────────────────────────────────
# Contract: tasks/REJECTION-LEDGER-SPEC.md. Every gate that kills a fully specified
# setup leaves a row, so a rejection becomes a scoreable paper trade instead of a
# console line nobody reads. Before this, an AI-filter veto and "no signal fired at
# all" produced byte-identical evidence: nothing.
#
# This is observability. It changes NOTHING about what trades. Every skip and return
# below stays exactly where it was; a row is posted beside it, never instead of it,
# and a ledger failure is swallowed into one log line.
REJECTION_ENDPOINT       = f"{SERVER_URL}/api/rejections"
# Short on purpose: this runs on the polling thread, and a trading bridge must not
# stall behind a logging endpoint.
REJECTION_POST_TIMEOUT_S = 3
REJECTION_SIDE           = "bridge"

# The gates the endpoint accepts (spec section 2). Posting anything else makes the
# server drop the row with a warning, so unknown gates are filtered here instead —
# maxTradesPerDay is a real cap with no gate name, and posting it would emit a
# deliberate warning on every poll forever.
LEDGER_GATES = frozenset((
    "MIN_RR", "ENTRY_RSI", "CONFIDENCE", "COHORT_FLOOR", "SPREAD",
    "AI_FILTER", "NEWS_BLACKOUT", "STALE_SOURCE", "DUPLICATE", "MAX_POSITIONS",
))

# server/sizing.js returns only a prose reason, so its duplicate-position guard can
# only be told apart from the portfolio cap and its own MIN_RR by this prefix —
# `Already holding ${symbol} ${direction}` at server/sizing.js:232. Changing that
# string there silently stops DUPLICATE rows being written here.
RISK_ENGINE_DUPLICATE_PREFIX = "already holding"

# Last level signature recorded per (gate, sourceSymbol, timeframe). Spec 3.2: gates
# re-fire on every poll, and without this the ledger would take thousands of near
# identical rows a day for one drifting setup. A volume control, not a correctness
# mechanism — losing it on restart costs nothing.
_rejection_signatures  = {}
_rejection_lock        = threading.Lock()
_rejection_last_error  = ""


def _as_number(value):
    """`value` as a finite float, or None when it is not a usable number.

    Levels arrive from a JSON payload where a null or a string is entirely possible,
    and a row must never carry a level that cannot be compared arithmetically. bool
    is excluded explicitly because float(True) is 1.0, which would write a price of 1.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _rejection_is_scoreable(setup, entry, stop, target):
    """Spec 3.1: only a setup that FORMED and was then killed is a rejection.

    A step where nothing formed is a non-event — XAUUSD alone has 3799 of them in a
    five-year replay — and logging those buries the rows that answer something. There
    must be a real setup name and a real entry/stop/target triple.
    """
    if not setup or str(setup).upper() == "WAIT":
        return False
    return None not in (entry, stop, target)


def _rejection_is_new(gate, source_symbol, timeframe, signature):
    """False when this exact setup was already recorded for this gate and instrument.

    Scoped per gate + sourceSymbol + timeframe because the same asset legitimately
    rejects a D1 and an H1 setup independently. Locked because process_all_signals
    runs three assets on three threads.
    """
    scope = (gate, source_symbol, timeframe)
    with _rejection_lock:
        if _rejection_signatures.get(scope) == signature:
            return False
        _rejection_signatures[scope] = signature
        return True


def _note_rejection_failure(gate, message):
    """Report a ledger failure once per distinct message, not once per poll.

    Same reasoning as last_rejection: an alarm that repeats every cycle is one you
    stop reading, and an undeployed endpoint would otherwise log three lines a minute.
    """
    global _rejection_last_error
    if message == _rejection_last_error:
        return
    _rejection_last_error = message
    log(f"Rejection ledger: {gate} row not recorded ({message}) — trading unaffected.", YELLOW)


def log_rejection(gate, sig, broker_symbol, entry, stop, target,
                  threshold=None, actual=None, reason=None):
    """Record one bridge-side gate rejection. Never raises, never blocks a decision.

    The whole body sits inside one try/except on purpose. Two of the call sites are
    inside functions that fail OPEN on exception — claude_approves_trade returns True
    so a network problem cannot block every trade — so an exception escaping here
    would turn a REJECTED verdict into a silent approval. A logging bug must never be
    able to open a position.

    `threshold` and `actual` are numeric-or-null throughout the ledger so a sweep can
    compare them without type-checking every row; anything non-numeric that explains
    the kill (a news headline, Claude's risk grade) goes in `reason`.
    """
    global _rejection_last_error
    try:
        if gate not in LEDGER_GATES:
            return
        signal_dict  = sig if isinstance(sig, dict) else {}
        entry_price  = _as_number(entry)
        stop_price   = _as_number(stop)
        target_price = _as_number(target)
        setup        = signal_dict.get("setup")
        direction    = signal_dict.get("signal")
        if not _rejection_is_scoreable(setup, entry_price, stop_price, target_price):
            return

        # The instrument the LEVELS were priced on, which is NOT always the instrument
        # this bridge would have filled — STALE_SOURCE fires on exactly that gap. The
        # broker symbol is never substituted here: a guessed sourceSymbol scores GC=F
        # futures levels against XAUUSD spot bars, ~$51 apart when last measured, and
        # produces a confidently wrong verdict rather than an honest null.
        source_symbol = signal_dict.get("sourceSymbol") or None
        # setupTimeframe names the chart the levels came from (server/index.js:1627);
        # a top-level `timeframe` is not stamped on the MTF signal at all.
        timeframe     = signal_dict.get("setupTimeframe") or None

        signature = "|".join(str(part) for part in
                             (setup, direction, entry_price, stop_price, target_price))
        if not _rejection_is_new(gate, source_symbol, timeframe, signature):
            return

        indicators = signal_dict.get("indicators")
        row = {
            "ts":           datetime.utcnow().isoformat() + "Z",
            "gate":         gate,
            "side":         REJECTION_SIDE,
            "ticker":       signal_dict.get("ticker"),
            "label":        signal_dict.get("label"),
            "dataSource":   signal_dict.get("dataSource"),
            "sourceSymbol": source_symbol,
            # The instrument this bridge would have FILLED. Equal to sourceSymbol on a
            # healthy MT5-fed signal and deliberately different on a STALE_SOURCE row,
            # which is the whole content of that rejection.
            "brokerSymbol": broker_symbol or None,
            "timeframe":    timeframe,
            "setup":        setup,
            "direction":    direction,
            "entry":        entry_price,
            "stop":         stop_price,
            "target":       target_price,
            "rr":           _as_number(signal_dict.get("rr")),
            "confidence":   _as_number(signal_dict.get("confidence")),
            "strength":     signal_dict.get("strength"),
            "threshold":    threshold,
            "actual":       actual,
            "reason":       reason or None,
            "trend":        signal_dict.get("trend"),
            "rsi":          _as_number(indicators.get("rsi")) if isinstance(indicators, dict) else None,
            "account":      ACCOUNT_TAG or "default",
        }

        res = requests.post(REJECTION_ENDPOINT, json=row, timeout=REJECTION_POST_TIMEOUT_S)
        res.raise_for_status()
        _rejection_last_error = ""
    except Exception as exc:
        _note_rejection_failure(gate, str(exc))


def auto_detect_symbols():
    """Auto-detect available MT5 symbols by checking broker's symbol list."""
    global SYMBOL_MAP, MIN_LOT
    all_symbols = {s.name for s in (mt5.symbols_get() or [])}
    log(f"Broker has {len(all_symbols)} symbols available — auto-detecting...", CYAN)

    for se_ticker, candidates in SYMBOL_CANDIDATES.items():
        for candidate in candidates:
            if candidate in all_symbols:
                info = mt5.symbol_info(candidate)
                if info:
                    mt5.symbol_select(candidate, True)
                    SYMBOL_MAP[se_ticker] = candidate
                    MIN_LOT[candidate] = info.volume_min
                    log(f"  {se_ticker:12s} → {candidate:12s} (min lot: {info.volume_min})", GREEN)
                    break
        else:
            log(f"  {se_ticker:12s} → NOT FOUND on this broker (skipping)", YELLOW)

    if not SYMBOL_MAP:
        log("No tradeable symbols found — check broker symbol names.", RED)
        return False
    log(f"Auto-detect complete: {len(SYMBOL_MAP)} asset(s) ready to trade.", GREEN)
    return True


# ── MT5 → server candle feed ──────────────────────────────────────────────────
# Until this existed, every bar the signal engine read came from Yahoo Finance
# (GC=F, BTC-USD, ^GSPC) while every fill happened on the broker's own symbols
# (XAUUSD, BTCUSD, SP500). Those are different instruments: different price,
# different sessions, different bars. Entry/stop/target were computed on a
# continuous futures series and then sent to a broker quoting spot, so the levels
# did not exist on the chart the trade lived on, and Gold's volume ratio read ~18x
# because it compared a contract's volume against a continuous series' average.
#
# The bridge is the only process that can see MT5, so it is the only place these
# bars can come from. SYMBOL_MAP is already resolved by auto_detect_symbols(), so
# this reuses the mapping the executor itself trades on — the feed and the fill can
# never drift apart.
# d1 raised 300 -> 600 on 2026-08-09. EMA200 seeded on 300 bars carried ~5% of the
# oldest close inside today's value (Gold's EMA200 was $21 out against a converged
# reference); at 600 bars that is 0.25%. The walk-forward that validated gate 70
# replays a 400-bar window, so production was running on FEWER bars than the
# measurement that blessed it — at 300 bars gate 70 is 4/5, not the 5/5 on record.
#
# Payload is not the constraint any more: the full raw dump measured 101kb against
# express's 2mb limit, so +300 daily bars x 3 symbols costs ~18kb. The 413 in the
# _rates_to_bars comment below predates that limit being raised.
BAR_COUNT_BY_TIMEFRAME = {"d1": 600, "h4": 400, "h1": 400}

# Pushed on its own clock rather than every poll: 1100 bars x 3 symbols is a real
# payload, and the daily bar the signal engine cares about only closes once a day.
CANDLE_PUSH_INTERVAL_SEC = 300
_last_candle_push_at = 0.0

# SmartEntry tickers this bridge has successfully pushed MT5 bars for. Used to
# decide whether a Yahoo-stamped signal is a legitimate fallback (we have nothing
# better) or a stale cache the server has not recomputed yet (we do).
pushed_candle_tickers = set()


def _rates_to_bars(rates):
    """Convert an MT5 rates array to the {closes,highs,lows,volumes} shape the
    server's signal engine already consumes. Returns None if unusable.

    tick_volume, not real_volume: brokers leave real_volume at 0 on CFDs and
    synthetic symbols, and a series of zeros would make every volume ratio null
    and silently disable every volume-confirmed setup.
    """
    if rates is None or len(rates) == 0:
        return None
    # Rounded on the way out purely to keep the payload small: MT5 returns full
    # double precision, and the raw serialisation of 1100 bars x 4 series x 3
    # symbols measured ~240kb, which overran the server's JSON body limit and got
    # the whole push rejected with 413. Five decimals is far finer than any
    # instrument here quotes (XAUUSD and the indices are 2, BTCUSD is 2), so this
    # loses nothing an indicator could see. Volumes are counts — integers.
    PRICE_DECIMALS = 5
    try:
        bars = {
            "closes":  [round(float(r["close"]), PRICE_DECIMALS) for r in rates],
            "highs":   [round(float(r["high"]),  PRICE_DECIMALS) for r in rates],
            "lows":    [round(float(r["low"]),   PRICE_DECIMALS) for r in rates],
            "volumes": [float(int(r["tick_volume"]))             for r in rates],
            # Bar OPEN times, unix seconds. Added 2026-08-09 and the reason is not
            # cosmetic: the server judged freshness purely on when the push landed,
            # so a terminal that wedges and returns the same stale array forever
            # kept every health check green while the engine priced signals off old
            # bars. Push freshness is not data freshness, and without these the
            # difference is invisible. Also what AMD needs for real session
            # boundaries -- see the AMD entry in server/evidence_register.js.
            #
            # Costs one integer array per timeframe. The full raw dump measured
            # 101kb against express's 2mb limit, so this is not near the 413 that
            # shaped the original payload.
            "times":   [int(r["time"])                           for r in rates],
        }
    except (KeyError, ValueError, TypeError) as exc:
        log(f"Rate conversion failed: {exc}", YELLOW)
        return None
    # A NaN or inf reaching the indicators poisons every comparison downstream and
    # produces a confident-looking signal from garbage. Drop the whole timeframe.
    for series in bars.values():
        if not all(v == v and v not in (float("inf"), float("-inf")) for v in series):
            log("Rate series contained NaN/inf — discarding timeframe", YELLOW)
            return None
    return bars


def _symbol_spec(mt5_symbol):
    """
    What one lot of this symbol is actually worth, per 1.0 of price movement.

    The server sizes positions but has no MT5 access, so it was assuming 1.0 —
    correct for nothing here. XAUUSD is 100 oz per lot and the account is
    denominated in GBP, so a 1.0 move is 74.33 GBP per lot, and the old formula
    returned a size 74x too large. tick_value/tick_size is the right source
    because it already carries the contract size AND the account-currency
    conversion; a hardcoded table would carry neither and would drift with FX.

    Returns None on any failure — the server then refuses to size rather than
    sizing on a guess.
    """
    try:
        info = mt5.symbol_info(mt5_symbol)
        if not info or not info.trade_tick_size:
            return None
        value_per_point = info.trade_tick_value / info.trade_tick_size
        if not value_per_point or value_per_point <= 0:
            return None
        return {
            "valuePerPoint": value_per_point,
            "contractSize":  info.trade_contract_size,
            "minLot":        info.volume_min,
            "lotStep":       info.volume_step,
            "digits":        info.digits,
        }
    except Exception as exc:
        log(f"symbol_info({mt5_symbol}) for spec failed: {exc}", YELLOW)
        return None


def push_candles(force=False):
    """Push native D1/H4/H1 bars for every mapped symbol to the server.

    Failure here must never stop trading: the server keeps the Yahoo path as its
    fallback, so a push that does not land degrades the data source rather than
    halting the bridge.
    """
    global _last_candle_push_at
    if not SYMBOL_MAP:
        return
    now = time.time()
    if not force and now - _last_candle_push_at < CANDLE_PUSH_INTERVAL_SEC:
        return
    # Stamp the ATTEMPT, not just the success. Setting this only after a 200 left every
    # failure path below retrying on each 60s poll instead of backing off to the
    # interval — which is why a broken push logged once a minute rather than once every
    # five, and why the 413s came in a burst.
    _last_candle_push_at = now

    timeframes = {"d1": mt5.TIMEFRAME_D1, "h4": mt5.TIMEFRAME_H4, "h1": mt5.TIMEFRAME_H1}
    assets = {}
    for se_ticker, mt5_symbol in SYMBOL_MAP.items():
        bars_by_tf = {}
        for tf_name, tf_const in timeframes.items():
            try:
                rates = mt5.copy_rates_from_pos(mt5_symbol, tf_const, 0, BAR_COUNT_BY_TIMEFRAME[tf_name])
            except Exception as exc:
                log(f"copy_rates {mt5_symbol} {tf_name} raised: {exc}", YELLOW)
                continue
            converted = _rates_to_bars(rates)
            if converted:
                bars_by_tf[tf_name] = converted
        if bars_by_tf:
            assets[se_ticker] = {"symbol": mt5_symbol, "bars": bars_by_tf}
            spec = _symbol_spec(mt5_symbol)
            if spec:
                assets[se_ticker]["spec"] = spec

    if not assets:
        log("No MT5 bars available to push — server stays on its Yahoo fallback.", YELLOW)
        return

    try:
        res = requests.post(
            f"{SERVER_URL}/api/mt5/candles",
            json={"account": ACCOUNT_TAG or "default", "assets": assets},
            timeout=20,
        )
        res.raise_for_status()
        accepted = res.json().get("accepted", {})
        # Only tickers the server actually ACCEPTED count — a payload it rejected
        # (too few bars, unusable series) leaves it correctly on Yahoo, and blocking
        # trades over a rejection we caused would be worse than the fallback.
        for se_ticker, payload in assets.items():
            if any(payload["symbol"] == acc.get("symbol") for acc in accepted.values()):
                pushed_candle_tickers.add(se_ticker)
        summary = ", ".join(
            f"{se}->{assets[se]['symbol']}:{len(assets[se]['bars'])}tf"
            for se in assets
        )
        log(f"Pushed MT5 candles ({summary}) — server accepted {accepted}", CYAN)
    except Exception as exc:
        log(f"Candle push failed ({exc}) — server stays on its Yahoo fallback.", YELLOW)


def connect_mt5():
    init_ok = mt5.initialize(path=TERMINAL_PATH) if TERMINAL_PATH else mt5.initialize()
    if not init_ok:
        log(f"MT5 initialize() failed — error: {mt5.last_error()}", RED)
        log("Make sure MetaTrader 5 is open and logged into your broker account.", YELLOW)
        return False
    info = mt5.terminal_info()
    acc  = mt5.account_info()

    if acc is None:
        log("MT5 initialize() succeeded but account_info() is empty — the terminal is "
            "running but not logged into an account.", RED)
        log("Log the terminal into its broker account, then restart this bridge.", YELLOW)
        mt5.shutdown()
        return False

    # Wrong account is worse than no account: it trades, just not where you think.
    if EXPECTED_LOGIN and str(acc.login) != EXPECTED_LOGIN:
        log(f"REFUSING TO TRADE — terminal is logged into #{acc.login} but this bridge "
            f"({ACCOUNT_TAG or 'untagged'}) expects #{EXPECTED_LOGIN}.", RED)
        log("Two bridges on one account would place every trade twice at double risk. "
            "Fix the terminal login or MT5_EXPECTED_LOGIN before restarting.", YELLOW)
        mt5.shutdown()
        return False

    if info:
        log(f"MT5 connected: {acc.name} #{acc.login} @ {info.company}  (terminal: {info.path})", GREEN)
    else:
        log(f"MT5 connected: {acc.name} #{acc.login}", GREEN)
    log(f"Balance: ${acc.balance:.2f}  |  Equity: ${acc.equity:.2f}  |  Leverage: 1:{acc.leverage}", CYAN)
    return auto_detect_symbols()


# How hard to retry a mid-session reconnect. Deliberately shorter than the startup
# loop: the terminal is already installed and usually just restarting, and a long
# blocking retry inside the poll cycle would stall trade management on the
# positions that are still open.
RECONNECT_RETRIES = 3
RECONNECT_RETRY_DELAY_S = 10


def mt5_handle_is_live():
    """True when this process's IPC handle still reaches a logged-in terminal.

    MT5 restarts its own terminal for a pending LiveUpdate, and it is most likely to
    do so on a terminal that mt5.initialize() launched moments earlier. The python
    client keeps a handle to the process that exited; from then on copy_rates_from_pos
    and positions_get return None while nothing raises and nothing logs. This is
    checked every cycle because that failure is completely silent — on 2026-08-01
    bridge A ran blind for 28 minutes with a connected-looking banner in its log.

    terminal_info().connected is the field that matters: initialize() succeeding only
    proves a terminal answered once, not that it is still there.
    """
    try:
        info = mt5.terminal_info()
        if info is None or not getattr(info, "connected", False):
            return False
        return mt5.account_info() is not None
    except Exception:
        return False


def ensure_mt5_connection():
    """Re-establish the MT5 handle if it has gone stale. True when usable this cycle.

    Order matters on recovery: reconcile FIRST (while known_positions still holds what
    this bridge believed was open), then re-seed from live positions. Re-seeding first
    would erase the evidence reconciliation needs, and skipping the re-seed entirely
    would leave track_closed_positions diffing a stale set against a fresh one — every
    tracked ticket reported closed with an unknown P&L, writing fictional outcomes into
    the journal and the learning engine.
    """
    global known_positions
    if mt5_handle_is_live():
        return True

    log(f"MT5 handle is stale ({mt5.last_error()}) — the terminal under this bridge "
        f"has gone away. Reconnecting.", RED + BOLD)
    try:
        mt5.shutdown()
    except Exception:
        pass

    for attempt in range(1, RECONNECT_RETRIES + 1):
        if connect_mt5():
            try:
                reconcile_open_trades()
            except Exception as exc:
                log(f"Post-reconnect reconciliation failed ({exc}) — continuing.", YELLOW)
            live_positions = mt5.positions_get()
            known_positions = {p.ticket for p in live_positions if p.magic == MAGIC_NUMBER} \
                if live_positions else set()
            log(f"MT5 reconnected — tracking {len(known_positions)} open position(s) again.", GREEN)
            return True
        if attempt < RECONNECT_RETRIES:
            log(f"Reconnect attempt {attempt}/{RECONNECT_RETRIES} failed — "
                f"retrying in {RECONNECT_RETRY_DELAY_S}s…", YELLOW)
            time.sleep(RECONNECT_RETRY_DELAY_S)

    log("Could not reconnect to MT5 this cycle — retrying on the next poll.", RED)
    return False


def get_lot_size(symbol, entry, stop, risk_amount=None):
    """Convert a dollar risk budget into broker lots.

    risk_amount defaults to the flat RISK_PERCENT of balance. The server's risk
    engine passes an explicit budget instead, which is how the 6% portfolio cap and
    the correlation penalty reach live trades. The dollars->lots conversion stays
    here on purpose: it needs tick_value/tick_size from this broker's symbol, and
    the server's `suggestedSize` is a raw unit count, not lots. Treating that number
    as lots would mis-size every position.
    """
    acc = mt5.account_info()
    if not acc:
        return MIN_LOT.get(symbol, 0.01)

    balance      = acc.balance
    if risk_amount is None:
        risk_amount = balance * RISK_PERCENT / 100
    stop_distance = abs(entry - stop)
    if stop_distance == 0:
        return MIN_LOT.get(symbol, 0.01)

    sym_info = mt5.symbol_info(symbol)
    if not sym_info:
        return MIN_LOT.get(symbol, 0.01)

    tick_value  = sym_info.trade_tick_value   # $ per tick
    tick_size   = sym_info.trade_tick_size    # price per tick
    if tick_size == 0:
        return MIN_LOT.get(symbol, 0.01)

    pips_at_risk    = stop_distance / tick_size
    value_per_lot   = pips_at_risk * tick_value
    if value_per_lot == 0:
        return MIN_LOT.get(symbol, 0.01)

    raw_lots = risk_amount / value_per_lot

    # Fixed lot size overrides the risk maths entirely. This is what you want when
    # you would rather trade a known, small size than let a percentage of a large
    # balance decide - e.g. always 0.01 lots on gold regardless of the stop.
    fixed = float(strategy_settings.get("fixedLotSize", 0) or 0)
    if fixed > 0:
        raw_lots = fixed

    # Ceiling applies either way, so a wide stop on a big balance can never quietly
    # produce an enormous position.
    max_lots = float(strategy_settings.get("maxLotSize", 0) or 0)
    if max_lots > 0 and raw_lots > max_lots:
        log(f"Lot size capped: {raw_lots:.2f} → {max_lots:.2f} (maxLotSize)", YELLOW)
        raw_lots = max_lots

    step     = sym_info.volume_step
    lots     = round(raw_lots / step) * step
    # The broker's own floor and ceiling always win - asking for 0.005 where the
    # minimum is 0.01 would be rejected outright.
    lots     = max(lots, sym_info.volume_min)
    lots     = min(lots, sym_info.volume_max)
    return round(lots, 2)


# Last rejection reason per asset, so a standing rejection is logged once instead of
# once per poll. Same reasoning as the remote-halt transition logging: an alarm that
# repeats every cycle is one you stop reading.
last_rejection = {}


def open_positions_for_risk_engine():
    """Open SmartEntry positions in the shape server/sizing.js expects.

    calcPortfolioRisk needs entry, stop and lots per position to total up real
    money at risk, plus symbol and direction to spot correlated exposure.
    """
    out = []
    try:
        positions = mt5.positions_get()
        if not positions:
            return out
        for p in positions:
            if p.magic != MAGIC_NUMBER:
                continue
            out.append({
                "symbol":    p.symbol,
                "direction": "BUY" if p.type == 0 else "SELL",
                "entry":     float(p.price_open),
                "stop":      float(p.sl) if p.sl else float(p.price_open),
                "lots":      float(p.volume),
            })
    except Exception as exc:
        log(f"Could not read positions for risk check: {exc}", YELLOW)
    return out


def request_trade_approval(symbol, direction, entry, stop, target, confidence):
    """Ask the server's risk engine to approve and budget this trade.

    server/sizing.js holds the portfolio risk cap (6%), the single-trade cap (3%),
    the minimum R:R, a duplicate-position guard and a correlation penalty for being
    long or short several correlated markets at once. It was fully written and
    tested but nothing in the live path ever called it, so none of it applied to a
    real trade - the same way conviction sizing was dead code back in July.

    Returns (approved: bool, reason: str, risk_amount_usd: float or None).

    Fails CLOSED: no answer means no trade. That costs nothing, because signals come
    from this same server - if it cannot be reached there is no signal to act on
    anyway - and silently trading unguarded is the exact failure this closes.
    """
    acc = mt5.account_info()
    if not acc:
        return False, "no account info", None

    payload = {
        "accountBalance": float(acc.balance),
        "signal": {
            "symbol":     symbol,
            "direction":  direction,
            "entry":      float(entry),
            "stop":       float(stop),
            "target":     float(target),
            "confidence": float(confidence) if confidence is not None else 0.0,
        },
        "openPositions": open_positions_for_risk_engine(),
    }

    try:
        res = requests.post(f"{SERVER_URL}/api/size", json=payload, timeout=8)
        res.raise_for_status()
        verdict = res.json()
    except Exception as exc:
        return False, f"risk engine unreachable ({exc})", None

    if not verdict.get("approved"):
        return False, verdict.get("reason") or "rejected by risk engine", None

    # suggestedSize is riskAmount / stopDistance, so multiplying back gives the
    # dollar budget the engine approved - portfolio-aware, unlike a flat percentage.
    stop_distance = abs(float(entry) - float(stop))
    suggested     = float(verdict.get("suggestedSize") or 0)
    risk_amount   = suggested * stop_distance

    if risk_amount <= 0:
        return False, "risk engine approved a zero budget", None

    return True, verdict.get("reason") or "approved", risk_amount


# Strategy limits fetched from the server each cycle. Defaults match the server's
# own defaults so a bridge that cannot reach the server still behaves sanely.
strategy_settings = {
    "confidenceThreshold": 65,
    "maxConcurrentPositions": 3,
    "maxTradesPerDay": 5,
    "fixedLotSize": 0.0,   # 0 = size from risk; above 0 = always trade exactly this
    "maxLotSize": 10.0,    # hard ceiling regardless of what the risk maths asks for
    "minStrength": "MODERATE",  # lowest signal strength AUTO mode will take
}

# Trades opened today, reset on date change. Counted here rather than server-side
# because this bridge is what actually opens them.
trades_opened_today = 0
trades_count_date = datetime.now().date()


def refresh_strategy_settings():
    """Pull the current strategy limits. Keeps the last known values on failure."""
    global strategy_settings
    try:
        res = requests.get(f"{SERVER_URL}/api/strategy-settings", timeout=5)
        res.raise_for_status()
        data = res.json()
        for name in ("confidenceThreshold", "maxConcurrentPositions", "maxTradesPerDay"):
            if isinstance(data.get(name), (int, float)):
                strategy_settings[name] = int(data[name])
        # Lot sizes stay floats — int() here would make 0.01 become 0.
        for name in ("fixedLotSize", "maxLotSize"):
            if isinstance(data.get(name), (int, float)):
                strategy_settings[name] = float(data[name])
        if data.get("minStrength") in ("MODERATE", "STRONG"):
            strategy_settings["minStrength"] = data["minStrength"]
    except Exception:
        pass


def count_open_positions():
    try:
        positions = mt5.positions_get()
        if not positions:
            return 0
        return len([p for p in positions if p.magic == MAGIC_NUMBER])
    except Exception:
        return 0


def check_strategy_limits():
    """Enforce the slot and daily-trade caps. Returns (allowed, reason, limit_detail).

    Neither of these limits existed before: nothing capped concurrent positions,
    so the system could hold every asset at once, and nothing capped trades per
    day, so a choppy session could churn the account. The portfolio risk engine
    bounds total money at risk, which is related but not the same thing — three
    small positions can pass a risk cap and still be three ways of making the same
    bet.

    limit_detail is None when allowed and otherwise names WHICH cap fired, with the
    bar and the value that hit it. One prose reason covered both caps, so the
    rejection ledger would have had to re-parse an English sentence to find out
    which one — and would have recorded no number a sweep could ask "what if the
    cap had been 4" of.
    """
    global trades_opened_today, trades_count_date

    today = datetime.now().date()
    if today != trades_count_date:
        trades_count_date = today
        trades_opened_today = 0

    max_positions = strategy_settings.get("maxConcurrentPositions", 3)
    open_count = count_open_positions()
    if open_count >= max_positions:
        return (
            False,
            f"{open_count} positions already open (limit {max_positions})",
            {"gate": "MAX_POSITIONS", "threshold": max_positions, "actual": open_count},
        )

    max_trades = strategy_settings.get("maxTradesPerDay", 5)
    if trades_opened_today >= max_trades:
        return (
            False,
            f"{trades_opened_today} trades opened today (limit {max_trades})",
            # MAX_TRADES_PER_DAY is not in the ledger's gate enum, so LEDGER_GATES at
            # the call site drops it rather than making the server warn every poll.
            {"gate": "MAX_TRADES_PER_DAY", "threshold": max_trades, "actual": trades_opened_today},
        )

    return True, "", None


def check_spread(symbol):
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return False, 0, MAX_SPREAD_PTS
    info  = mt5.symbol_info(symbol)
    spread = (tick.ask - tick.bid) / info.trade_tick_size if info else 0
    cap = max_spread_for(symbol)
    ok = spread <= cap
    return ok, spread, cap


def build_order_comment(setup, confidence):
    """Name the trade so it is identifiable in the MT5 terminal.

    Every SmartEntry order used to carry the same static "SmartEntry" comment, so
    the terminal's Comment column said nothing about WHICH setup opened a position
    — you had to cross-reference the bridge log by timestamp to find out. MT5
    truncates this field (31 chars is the safe limit) and some brokers overwrite
    it entirely on partial fills, so it is a convenience, never the source of
    truth: MAGIC_NUMBER is what actually identifies our positions.
    """
    if not setup:
        return "SmartEntry"
    try:
        pct = int(round(float(confidence)))
    except (TypeError, ValueError, OverflowError):
        # Never invent a number here — a comment reading "SE MOMENTUM 0" would put
        # a fabricated 0% confidence in front of you in the terminal. Drop the
        # figure instead and keep the setup name, which is the useful part.
        return f"SE {setup}"[:31]
    # "SE " + setup + " " + up to 3 digits. RANGE_TRADE_SHORT is the longest setup
    # name at 17 chars, giving 24 worst case, so [:31] never cuts the name.
    return f"SE {setup} {pct}"[:31]


def place_order(symbol, signal_type, entry, stop, target, risk_amount=None,
                setup=None, confidence=None, sig=None):
    """Place a market order. risk_amount is the dollar budget the server's risk
    engine approved; without it the flat RISK_PERCENT is used, which ignores how
    much of the portfolio is already exposed.

    `sig` is the originating signal, carried purely so a spread rejection can be
    written to the ledger with its ticker, source instrument and timeframe. It is
    never read on the execution path — passing None only costs the ledger row.
    """
    spread_ok, spread, spread_cap = check_spread(symbol)
    if not spread_ok:
        log(f"Spread too wide on {symbol}: {spread:.0f} pts (max {spread_cap}) — skipping", YELLOW)
        # check_spread returns (False, 0, cap) when the symbol has no tick at all.
        # A quote outage is not a wide spread: recording actual=0 would file a row
        # asserting 0 points exceeded a 50-point cap, which cannot be true. The cap
        # is still recorded; the measurement is honestly null.
        spread_was_measured = spread > 0
        log_rejection(
            "SPREAD", sig, symbol, entry, stop, target,
            threshold=spread_cap,
            actual=round(float(spread), 1) if spread_was_measured else None,
            reason=(f"spread {spread:.0f} pts exceeds cap {spread_cap} pts"
                    if spread_was_measured
                    else f"no tick for {symbol} — spread could not be measured"),
        )
        return False

    order_type = mt5.ORDER_TYPE_BUY if signal_type == "BUY" else mt5.ORDER_TYPE_SELL
    tick       = mt5.symbol_info_tick(symbol)
    price      = tick.ask if signal_type == "BUY" else tick.bid
    lots       = get_lot_size(symbol, entry, stop, risk_amount=risk_amount)
    if risk_amount is not None:
        log(f"Sizing from risk-engine budget ${risk_amount:.2f} → {lots} lots", CYAN)

    request = {
        "action":        mt5.TRADE_ACTION_DEAL,
        "symbol":        symbol,
        "volume":        lots,
        "type":          order_type,
        "price":         price,
        "sl":            stop,
        "tp":            target,
        "deviation":     20,
        "magic":         MAGIC_NUMBER,
        "comment":       build_order_comment(setup, confidence),
        "type_time":     mt5.ORDER_TIME_GTC,
        "type_filling":  mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        log(f"ORDER PLACED: {signal_type} {lots} lot {symbol} @ {price:.2f}  SL:{stop}  TP:{target}", GREEN + BOLD)
        log(f"Ticket: #{result.order}", GREEN)
        # Notify server so it can generate commentary and log the trade
        try:
            # The signal this order was ACTUALLY placed on, sent with it.
            #
            # The server used to re-derive the setup by reading signalCache at
            # journal-write time, which is a different moment: the cache refreshes
            # between a signal firing and this POST landing, so the journal recorded
            # whatever the cache had moved on to. It produced both bad rows in the
            # journal — #1682651222 stamped BB_SQUEEZE_WATCH, a setup that hardcodes
            # signal="WAIT" and can never open a trade, and #1713655080 stamped
            # "WAIT" itself. That name is the bucket key updateLearning() counts
            # under, so with one closed trade in history, 100% of the learning data
            # was filed under a setup the engine will never take.
            #
            # `sig` is the originating signal and is already in scope. Sending
            # `direction` lets the server corroborate rather than trust blindly.
            signal_context = None
            if isinstance(sig, dict):
                signal_context = {
                    "setup":          sig.get("setup") or setup,
                    "setupTimeframe": sig.get("setupTimeframe"),
                    "confidence":     sig.get("confidence", confidence),
                    "strength":       sig.get("strength"),
                    "regime":         sig.get("regime"),
                    "atr":            sig.get("atr"),
                    "direction":      sig.get("signal"),
                    # The R:R the signal PLANNED. Sent for the same reason as the
                    # setup: read from the cache at write time it describes whichever
                    # signal happened to be cached then, not this trade's plan.
                    "rr":             sig.get("rr"),
                }
            elif setup:
                # No full signal, but the caller still knew the setup it traded.
                signal_context = {"setup": setup, "confidence": confidence,
                                  "direction": signal_type}

            requests.post(f"{SERVER_URL}/api/trade-opened", json={
                "ticket": result.order,
                "symbol": symbol,
                "type":   signal_type,
                "price":  round(price, 5),
                "sl":     stop,
                "tp":     target,
                "volume": lots,
                "account": ACCOUNT_TAG or "default",
                "signalContext": signal_context,
            }, timeout=JOURNAL_REQUEST_TIMEOUT_S)
        except Exception as e:
            log(f"Could not POST trade-opened to server: {e}", YELLOW)
        known_positions.add(result.order)
        return True
    else:
        log(f"Order failed (retcode {result.retcode}): {result.comment}", RED)
        return False


def prompt_confirm(sig, symbol):
    direction  = sig["signal"]
    entry      = sig.get("entry")
    stop       = sig.get("stop")
    target     = sig.get("target")
    rr         = sig.get("rr")
    rsi        = sig.get("indicators", {}).get("rsi")
    trend      = sig.get("trend", "")
    strength   = sig.get("strength", "")
    setup      = sig.get("setup", "").replace("_", " ")

    color = GREEN if direction == "BUY" else RED

    print()
    print(f"{color}{BOLD}{'='*60}{RESET}")
    print(f"{color}{BOLD}  {sig['label']} — {strength} {direction} ({setup}){RESET}")
    print(f"{color}{'='*60}{RESET}")
    print(f"  Trend:    {trend}")
    print(f"  Price:    ${sig['price']:,.2f}")
    print(f"  Entry:    ${entry:,.2f}")
    print(f"  Stop:     ${stop:,.2f}")
    print(f"  Target:   ${target:,.2f}")
    if rr:
        print(f"  R/R:      1:{rr}  {'✓ Good' if rr >= 2 else '⚠ Tight'}")
    print(f"  RSI:      {rsi}")
    print(f"  MT5 sym:  {symbol}")
    acc = mt5.account_info()
    if acc:
        lots = get_lot_size(symbol, entry, stop)
        risk_usd = acc.balance * RISK_PERCENT / 100
        print(f"  Lots:     {lots}  (${risk_usd:.2f} risk at {RISK_PERCENT}% of ${acc.balance:.2f})")
    print(f"{color}{'='*60}{RESET}")

    if AUTO_MODE:
        log(f"AUTO-MODE: executing {direction} on {symbol}", YELLOW)
        return True

    answer = input(f"\n{BOLD}Execute this trade? [y/N]: {RESET}").strip().lower()
    return answer in ("y", "yes")


def process_signal(key, sig):
    if not sig:
        return
    direction = sig.get("signal")
    strength  = sig.get("strength")
    ticker    = sig.get("ticker")
    updated   = sig.get("updatedAt", "")

    # Only act on non-WAIT signals
    if direction == "WAIT":
        return

    # Deduplicate — only trade each unique signal once
    cache_key = f"{key}_{direction}_{updated}"
    if executed_signals.get(key) == cache_key:
        return

    # In semi-auto: act on any BUY/SELL. In auto: whatever minStrength allows.
    #
    # This was hardcoded to STRONG, which is why the self-learning engine never had
    # data: learning needs 5 closed trades per setup before it adjusts anything, and
    # STRONG-only fires roughly once a month. Allowing MODERATE raises that to about
    # one signal every 2.4 days. On a demo account that trade-off is worth making —
    # you cannot learn from a trade you never took.
    if AUTO_MODE:
        allowed = ("STRONG",) if strategy_settings["minStrength"] == "STRONG" else ("STRONG", "MODERATE")
        if strength not in allowed:
            return

    # Halt checks sit HERE, after we know there is a real, actionable, not-yet-taken
    # signal. Checked earlier they fired on every WAIT for every asset every cycle —
    # thousands of log lines a day announcing that nothing was blocked, which buries
    # the one line that matters. Now a halt is logged only when it actually stopped a
    # trade, and the signal is not marked executed, so it can still be taken if the
    # halt is lifted while the setup is live.
    #
    # Remote halt is reported separately from the local circuit breakers so the log
    # always says WHICH one stopped it. Neither touches open positions.
    if remote_halted:
        log(f"Remote halt active: {remote_halt_reason} — NOT opening {direction} on {ticker}.", RED)
        return
    if check_circuit_breaker():
        log(f"Circuit breaker active: {halt_reason} — NOT opening {direction} on {ticker}.", RED)
        return

    symbol = SYMBOL_MAP.get(ticker)
    if not symbol:
        log(f"No MT5 symbol for {ticker} — skipping", YELLOW)
        executed_signals[key] = cache_key
        return

    # Never fill one instrument using another instrument's levels.
    #
    # The server computes signals from MT5 bars when it has them and falls back to
    # Yahoo when it does not, stamping which it used. Those are different
    # instruments: measured 2026-07-30, Yahoo GC=F read 4156.10 while the XAUUSD we
    # actually fill read 4104.72 — $51 apart, 56% of that setup's stop distance —
    # and the H4 BREAKOUT driving the signal did not exist on XAUUSD at all.
    #
    # This is not hypothetical. signalCache only recomputes on a 30-minute cron, so
    # a freshly started bridge can fetch a signal built from Yahoo bars minutes
    # before its own first candle push lands. That is exactly how ticket #1682651222
    # was opened: a Yahoo-derived Gold BUY at confidence 85 that read WAIT at
    # confidence 0 the moment the same engine saw XAUUSD.
    #
    # Deliberately fails OPEN on an unknown source: a server too old to stamp
    # dataSource returns None here, and refusing to trade against it would silently
    # freeze a working system. Only an explicit "yahoo" blocks, and only for symbols
    # this bridge has actually pushed bars for — otherwise Yahoo is the legitimate
    # fallback and there is nothing better available.
    data_source = sig.get("dataSource")
    if data_source == "yahoo" and ticker in pushed_candle_tickers:
        log(f"STALE SOURCE: {ticker} signal was computed from Yahoo, but MT5 bars for "
            f"{symbol} have been pushed — refusing to trade another instrument's levels. "
            f"Waiting for the server to recompute.", YELLOW)
        # The one gate where sourceSymbol and brokerSymbol provably differ — that gap
        # IS the rejection. The levels below come straight off the signal because the
        # entry/stop/target guard has not run yet; log_rejection drops the row if any
        # of them is missing rather than inventing one.
        log_rejection(
            "STALE_SOURCE", sig, symbol,
            sig.get("entry"), sig.get("stop"), sig.get("target"),
            reason=f"levels priced on {sig.get('sourceSymbol') or ticker} (yahoo) while "
                   f"MT5 bars for {symbol} are already pushed",
        )
        return

    # Check news blackout before executing
    blackout, blackout_reason = check_news_blackout()
    if blackout:
        log(f"NEWS BLACKOUT — skipping {ticker}: {blackout_reason}", YELLOW)
        log_rejection(
            "NEWS_BLACKOUT", sig, symbol,
            sig.get("entry"), sig.get("stop"), sig.get("target"),
            reason=blackout_reason,
        )
        return

    # Check symbol is tradeable
    if not mt5.symbol_select(symbol, True):
        log(f"Cannot select {symbol} in MT5 — check symbol name for your broker", RED)
        return

    entry  = sig.get("entry")
    stop   = sig.get("stop")
    target = sig.get("target")

    if not entry or not stop or not target:
        log(f"Incomplete levels for {key} — skipping", YELLOW)
        executed_signals[key] = cache_key
        return

    # Slot and daily-trade caps. Cheapest checks first — both are local counts.
    limits_ok, limits_reason, limit_detail = check_strategy_limits()
    if not limits_ok:
        if last_rejection.get(key) != limits_reason:
            log(f"STRATEGY LIMIT blocked {direction} {symbol}: {limits_reason}", YELLOW)
            last_rejection[key] = limits_reason
        # Only MAX_POSITIONS has a gate name in the ledger enum; log_rejection drops
        # the daily-trade cap silently rather than making the endpoint warn per poll.
        if limit_detail:
            log_rejection(
                limit_detail["gate"], sig, symbol, entry, stop, target,
                threshold=limit_detail["threshold"],
                actual=limit_detail["actual"],
                reason=limits_reason,
            )
        return

    # Portfolio risk gate. Runs BEFORE the AI filter so a trade that breaches the
    # portfolio cap never costs an Anthropic call, and so the cheaper deterministic
    # check is what rejects it.
    #
    # Deliberately does NOT mark the signal executed on rejection: "portfolio at 6%"
    # and "already holding BTCUSD BUY" are temporary states, and the same setup
    # should be tradeable once a position closes. Permanent problems with this
    # signal (bad R:R, confidence too low) simply keep failing harmlessly.
    approved, risk_reason, approved_risk_usd = request_trade_approval(
        symbol, direction, entry, stop, target, sig.get("confidence")
    )
    if not approved:
        if last_rejection.get(key) != risk_reason:
            log(f"RISK ENGINE blocked {direction} {symbol}: {risk_reason}", RED)
            last_rejection[key] = risk_reason
        # Only the duplicate-position guard has a gate in the ledger enum. The
        # portfolio cap, the single-trade cap and sizing.js's own MIN_RR do not — and
        # MIN_RR is already recorded engine-side, so posting it here would count one
        # rejection twice and inflate whatever the scorer concludes about that gate.
        if risk_reason and risk_reason.strip().lower().startswith(RISK_ENGINE_DUPLICATE_PREFIX):
            log_rejection("DUPLICATE", sig, symbol, entry, stop, target, reason=risk_reason)
        return
    if last_rejection.pop(key, None):
        log(f"Risk engine now allows {symbol} — {risk_reason}", GREEN)

    # Claude AI approval (only in AUTO mode — in semi-auto the human decides)
    if AUTO_MODE:
        ai_ok = claude_approves_trade(sig, symbol, entry, stop, target)
        if not ai_ok:
            log(f"Trade BLOCKED by Claude AI filter — {ticker}", RED)
            executed_signals[key] = cache_key  # mark so we don't retry same signal
            return

    confirmed = prompt_confirm(sig, symbol)
    if confirmed:
        ok = place_order(symbol, direction, entry, stop, target, risk_amount=approved_risk_usd,
                         setup=sig.get("setup"), confidence=sig.get("confidence"), sig=sig)
        if ok:
            executed_signals[key] = cache_key
            global trades_opened_today
            trades_opened_today += 1
            log(f"Trades opened today: {trades_opened_today}/{strategy_settings.get('maxTradesPerDay', 5)}", CYAN)
    else:
        log(f"Trade on {symbol} skipped by user", YELLOW)
        executed_signals[key] = cache_key  # mark so we don't prompt again this signal


def report_risk_status():
    """Push this bridge's risk state and the limits it actually enforces, every cycle.

    This used to be sent only when a trade CLOSED, so on an account with no closed
    trades the dashboard never learned the real limits and the circuit-breaker cards
    had nothing to show. The limits are the whole point of the panel: they need to be
    visible before the first trade, not after it.

    This is also where the halt cooldown is EVALUATED, every cycle. Putting it only in
    check_circuit_breaker() would have rebuilt the exact defect being fixed: that
    function runs on a trade attempt, and a halted box with all three assets on WAIT
    never attempts one, so a cooldown that only ticked there would never expire.
    """
    released = release_streak_halt_if_cooled()
    if released:
        log("Cooldown expired — reporting this box as live again.", CYAN)
    cooldown_left = halt_cooldown_remaining_seconds()
    try:
        requests.post(f"{SERVER_URL}/api/risk-status", json={
            "dailyPnl": round(daily_pnl, 2),
            "consecutiveLosses": consecutive_losses,
            "halted": trading_halted or remote_halted,
            "haltReason": halt_reason or remote_halt_reason,
            "account": ACCOUNT_TAG or "default",
            # When the halt was set, which breaker set it, and when it frees itself.
            # A halt with no visible end date reads as permanent to whoever finds it,
            # which is how the previous one went unnoticed.
            "haltedAt":   halted_at or None,
            "haltCause":  halt_cause or None,
            "haltReleasesInSeconds": round(cooldown_left) if cooldown_left is not None else None,
            "config": {
                "riskPercent":     RISK_PERCENT,
                "dailyLossPct":    daily_loss_limit,
                "maxConsecLosses": MAX_CONSECUTIVE_LOSSES,
                "maxSpreadPts":    MAX_SPREAD_PTS,
                "autoMode":        AUTO_MODE,
                "expectedLogin":   EXPECTED_LOGIN or None,
                "remoteHalted":    remote_halted,
                "haltCooldownHours": HALT_COOLDOWN_HOURS,
            },
        }, timeout=3)
    except Exception:
        # Reporting is telemetry, never a reason to interrupt trading.
        pass


def report_positions():
    """Send open MT5 positions to SmartEntry server so the dashboard can display them."""
    try:
        positions = mt5.positions_get()
        # None is an MT5 error, () is genuinely no positions. Returning silently on
        # None made a live process with a dead terminal indistinguishable from a dead
        # process: the heartbeat simply stopped and nothing said why, so the healer
        # reported "A silent for 1268s" while the bridge was running normally.
        if positions is None:
            log(f"positions_get() failed ({mt5.last_error()}) — heartbeat skipped, "
                f"MT5 handle looks dead.", YELLOW)
            return
        data = []
        for p in positions:
            if p.magic != MAGIC_NUMBER:
                continue  # only SmartEntry trades
            data.append({
                "ticket":  p.ticket,
                "symbol":  p.symbol,
                "type":    "BUY" if p.type == 0 else "SELL",
                "volume":  p.volume,
                "price":   p.price_open,
                "sl":      p.sl,
                "tp":      p.tp,
                "profit":  round(p.profit, 2),
                "openTime": datetime.fromtimestamp(p.time).strftime("%H:%M:%S"),
            })
        requests.post(f"{SERVER_URL}/api/mt5/positions", json={"positions": data, "account": ACCOUNT_TAG or "default"}, timeout=5)
    except Exception as exc:
        # This POST is the ONLY thing that writes mt5LastSeenByAccount on the server,
        # so swallowing its failure silently meant the single signal the healer watches
        # could stop with no trace anywhere. Still non-fatal — a missed heartbeat must
        # not stop trade management — but never again invisible.
        log(f"Heartbeat POST failed ({exc}) — healer will read this bridge as silent.", YELLOW)


def print_status(signals):
    now   = datetime.now().strftime("%H:%M:%S")
    parts = []
    for k, label in [("btc", "BTC"), ("gold", "Gold"), ("spx", "SP500")]:
        s = signals.get(k)
        if s:
            sig = s.get("signal", "?")
            rsi = s.get("indicators", {}).get("rsi", "?")
            color = GREEN if sig == "BUY" else RED if sig == "SELL" else YELLOW
            parts.append(f"{color}{label}:{sig}(RSI {rsi}){RESET}")
    print(f"[{now}] {' | '.join(parts)}")


def check_news_blackout():
    """Ask the server if we're inside a 30-min news blackout window."""
    try:
        res = requests.get(f"{SERVER_URL}/api/newsfilter", timeout=5)
        data = res.json()
        return data.get("blackout", False), data.get("reason", None)
    except Exception:
        return False, None  # fail open — don't block trades if server unreachable


def claude_approves_trade(sig, symbol, entry, stop, target):
    """Ask Claude Opus to approve or reject this trade before execution."""
    try:
        res = requests.post(
            f"{SERVER_URL}/api/claude-approve-trade",
            json={"signal": sig, "symbol": symbol, "entry": entry, "stop": stop, "target": target},
            timeout=25
        )
        data = res.json()
        approved = data.get("approved", True)
        reason   = data.get("reason", "")
        risk     = data.get("risk", "MEDIUM")
        color = GREEN if approved else RED
        log(f"Claude AI: {'APPROVED' if approved else 'REJECTED'} [{risk}] — {reason}", color)
        if not approved:
            # Until now this log line was the ONLY trace of an AI veto anywhere in the
            # system: a setup blocked here and a setup that never formed produced
            # identical evidence, so the filter could never be scored against what
            # price actually did. There is no numeric bar to clear, so threshold and
            # actual stay null and the grade rides in `reason`.
            log_rejection("AI_FILTER", sig, symbol, entry, stop, target,
                          reason=f"[{risk}] {reason}" if reason else f"[{risk}] no reason given")
        return approved
    except Exception as e:
        log(f"AI approval unavailable ({e}) — proceeding", YELLOW)
        return True  # fail open so network issues don't block all trades


def load_position_r():
    """Restore each open position's true initial risk from the previous run.

    Fails open: an unreadable file leaves the dict empty and every ticket falls
    through to the journal lookup below, which is the more authoritative source
    anyway. Logged loudly so a corrupt file is never silent.
    """
    try:
        with open(POSITION_R_PATH, "r", encoding="utf-8") as r_file:
            stored = json.load(r_file)
    except FileNotFoundError:
        return
    except Exception as exc:
        log(f"Position risk store unreadable ({exc}) — will re-derive from the journal.", YELLOW)
        return

    if not isinstance(stored, dict):
        log("Position risk store is not an object — ignoring it.", YELLOW)
        return

    # JSON object keys are always strings; tickets are ints everywhere else.
    for ticket_key, risk in stored.items():
        try:
            risk_value = float(risk)
        except (TypeError, ValueError):
            continue
        if risk_value > 0:
            position_initial_r[int(ticket_key)] = risk_value

    if position_initial_r:
        log(f"Restored initial risk for {len(position_initial_r)} position(s).", CYAN)


def save_position_r():
    """Persist the initial-risk map. Never raises — a write failure must not stop trading."""
    try:
        with open(POSITION_R_PATH, "w", encoding="utf-8") as r_file:
            json.dump({str(t): v for t, v in position_initial_r.items()}, r_file, indent=2)
    except Exception as exc:
        log(f"Could not persist position risk ({exc}) — trailing may reset on restart.", YELLOW)


def initial_r_from_journal(ticket, symbol):
    """This position's ORIGINAL risk distance, from the journal row written at entry.

    The journal stores the entry and stop the signal was actually filled with, and
    nothing ever rewrites them, so it is the one record a later stop move cannot
    corrupt. Returns None when the row is missing or unusable — never a guess.
    """
    try:
        res = requests.get(
            f"{SERVER_URL}/api/journal",
            params={"limit": JOURNAL_FETCH_LIMIT},
            timeout=JOURNAL_REQUEST_TIMEOUT_S,
        )
        res.raise_for_status()
        entries = res.json().get("journal")
    except Exception as exc:
        log(f"Journal unreachable ({exc}) — cannot recover initial risk for #{ticket}.", YELLOW)
        return None

    if not isinstance(entries, list):
        return None

    for entry_row in entries:
        if not isinstance(entry_row, dict) or entry_row.get("ticket") != ticket:
            continue
        if entry_row.get("symbol") != symbol:
            # Same ticket id on a different instrument is a different trade entirely.
            continue
        try:
            journal_entry = float(entry_row.get("entry"))
            journal_stop  = float(entry_row.get("sl"))
        except (TypeError, ValueError):
            return None
        risk = abs(journal_entry - journal_stop)
        return risk if risk > 0 else None

    return None


def resolve_initial_r(position):
    """The risk distance the ladder measures profit in. None when it cannot be trusted.

    Three sources, in descending order of authority:

      1. the persisted store — written once, never recomputed from a live stop
      2. the journal row for this ticket — the levels the trade was opened with
      3. the live stop, but ONLY while it still sits on the losing side of entry,
         which proves nothing has moved it yet

    Deliberately no fourth fallback. Guessing R from a stop that has already been
    moved is exactly the bug this replaces; refusing to act and saying so is the
    correct behaviour when the true risk is unknown.
    """
    ticket = position.ticket
    known  = position_initial_r.get(ticket)
    if known and known > 0:
        return known

    from_journal = initial_r_from_journal(ticket, position.symbol)
    if from_journal:
        position_initial_r[ticket] = from_journal
        save_position_r()
        log(f"Initial risk for #{ticket} {position.symbol} recovered from journal: "
            f"{from_journal:.5g}", CYAN)
        return from_journal

    entry  = position.price_open
    stop   = position.sl
    is_buy = (position.type == 0)
    stop_is_untouched = stop != 0 and ((is_buy and stop < entry) or (not is_buy and stop > entry))
    if stop_is_untouched:
        risk = abs(entry - stop)
        if risk > 0:
            position_initial_r[ticket] = risk
            save_position_r()
            return risk

    if ticket not in trail_unresolved_logged:
        trail_unresolved_logged.add(ticket)
        log(f"NO TRAIL #{ticket} {position.symbol}: initial risk unknown — no stored "
            f"value, no journal row, and the live stop ({stop}) has already moved off "
            f"the risk side of entry ({entry}). Stop will NOT be managed.", RED)
    return None


def ladder_stop_price(entry, risk, price, is_buy):
    """Where the ratchet says the stop belongs right now. None below the arm level.

    Steps are floored, not rounded, so the stop only ever locks in profit the trade
    has actually already made.
    """
    # Binary floating point puts an exact 1.0R at 0.9999999999999995, which floors to
    # the step below and arms the ladder a tick later than the table above promises.
    # One part in a billion is far finer than any instrument's tick, so absorbing it
    # can never bring a step forward by a real price increment.
    step_epsilon = 1e-9

    profit_r = (price - entry) / risk if is_buy else (entry - price) / risk
    if profit_r < TRAIL_ARM_R - step_epsilon:
        return None

    steps_taken = math.floor((profit_r - TRAIL_ARM_R) / TRAIL_STEP_R + step_epsilon)
    locked_r    = steps_taken * TRAIL_STEP_R + TRAIL_ARM_R - TRAIL_GIVEBACK_R
    # Once armed the stop is never worse than breakeven, whatever the env vars say.
    locked_r    = max(locked_r, 0.0)

    return entry + locked_r * risk if is_buy else entry - locked_r * risk


def broker_stop_limit(symbol, price, is_buy):
    """The closest a stop may legally sit to `price`. None when the broker is silent.

    MT5 rejects a stop inside trade_stops_level with retcode 10016, and the previous
    implementation never checked, so a step landing near price failed instead of
    being placed at the nearest legal level.
    """
    info = mt5.symbol_info(symbol)
    if info is None:
        return None
    min_distance = info.trade_stops_level * info.point
    if min_distance <= 0:
        return None
    return price - min_distance if is_buy else price + min_distance


_trail_disabled_logged = False


def manage_trailing_stops():
    """Ratchet each open stop up the profit ladder. Never widens a stop.

    Disabled by default since 2026-08-07 — see TRAIL_LADDER_ENABLED above. Stops that
    the ladder ALREADY moved stay where they are: they live at the broker, and this
    function is the only thing that would advance them. Disabling it freezes those
    stops rather than resetting them, so locked profit is not given back.
    """
    global _trail_disabled_logged
    if not TRAIL_LADDER_ENABLED:
        if not _trail_disabled_logged:
            _trail_disabled_logged = True
            log("Trailing ladder OFF (measured: `off` is the only give-back never "
                "negative across 4/5/7-fold walk-forwards). Stops already moved stay "
                "put; new ones will not advance. TRAIL_LADDER_ENABLED=1 re-enables.", CYAN)
        return

    try:
        res  = requests.get(f"{SERVER_URL}/api/features", timeout=5)
        feat = res.json().get("features", {})
        if not feat.get("trailingStop", True):
            return
    except Exception:
        pass  # if server unreachable, run anyway (trailing stops are safety-critical)

    positions = mt5.positions_get()
    if positions is None:
        log(f"positions_get() failed ({mt5.last_error()}) — stops not managed this cycle.", YELLOW)
        return
    if not positions:
        return

    for p in positions:
        if p.magic != MAGIC_NUMBER:
            continue

        risk = resolve_initial_r(p)
        if not risk:
            continue

        ticket = p.ticket
        entry  = p.price_open
        stop   = p.sl
        price  = p.price_current
        is_buy = (p.type == 0)
        symbol = p.symbol

        target_stop = ladder_stop_price(entry, risk, price, is_buy)
        if target_stop is None:
            continue

        info = mt5.symbol_info(symbol)
        if info is None:
            log(f"symbol_info({symbol}) unavailable — #{ticket} stop not managed.", YELLOW)
            continue
        tick_size = info.point

        # Clamp into the broker's legal zone rather than sending a stop it will reject.
        legal_stop = broker_stop_limit(symbol, price, is_buy)
        if legal_stop is not None:
            target_stop = min(target_stop, legal_stop) if is_buy else max(target_stop, legal_stop)

        target_stop = round(target_stop, info.digits)

        # Never widen. A stop of 0 means no protection at all, so anything beats it.
        if stop == 0:
            improves = True
        elif is_buy:
            improves = target_stop > stop + tick_size
        else:
            improves = target_stop < stop - tick_size
        if not improves:
            continue

        locked_r = (target_stop - entry) / risk if is_buy else (entry - target_stop) / risk
        result = mt5.order_send({
            "action":   mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol":   symbol,
            "sl":       target_stop,
            "tp":       p.tp,
            "magic":    MAGIC_NUMBER,
        })
        if result is None:
            log(f"SL update returned nothing for #{ticket} ({mt5.last_error()})", RED)
        elif result.retcode == mt5.TRADE_RETCODE_DONE:
            log(f"TRAIL #{ticket} {symbol}: SL {stop} → {target_stop} "
                f"(locks {locked_r:+.2f}R)", GREEN + BOLD)
        else:
            log(f"SL update failed #{ticket}: [{result.retcode}] {result.comment}", RED)


def take_partial_profit():
    """At 1R profit: close 50% of the position, move SL to breakeven.

    Dormant at the lot size this system actually trades. `fixedLotSize` is 0.01,
    which IS the broker minimum on all three instruments, so there is no half to
    close — a position of one minimum lot cannot be split at all. It used to reach
    that conclusion silently, via `round(0.5)` returning 0 under banker's rounding,
    so the function had never executed once in the system's life and nothing said
    why. Banking profit at these sizes is the trailing ladder's job; this stays for
    the day position sizes are large enough to scale out of, and now says so.
    """
    positions = mt5.positions_get()
    if positions is None or not positions:
        return

    for p in positions:
        if p.magic != MAGIC_NUMBER:
            continue
        ticket = p.ticket
        if ticket in position_partial_taken:
            continue  # already done for this trade

        r = position_initial_r.get(ticket)
        if not r or r == 0:
            continue

        entry  = p.price_open
        price  = p.price_current
        is_buy = (p.type == 0)

        at_1r = (is_buy and price >= entry + r) or (not is_buy and price <= entry - r)
        if not at_1r:
            continue

        # Close 50% of the position
        sym_info = mt5.symbol_info(p.symbol)
        if not sym_info:
            continue
        # Floor to the volume step: rounding could ask the broker to close MORE than
        # half, and round(0.5) is 0 in Python, which silently zeroed this entirely.
        half_vol = math.floor(p.volume / 2 / sym_info.volume_step) * sym_info.volume_step
        half_vol = round(half_vol, 8)  # kill float dust like 0.30000000000000004
        if half_vol < sym_info.volume_min or half_vol >= p.volume:
            if ticket not in partial_too_small_logged:
                partial_too_small_logged.add(ticket)
                log(f"Partial profit skipped #{ticket} {p.symbol}: {p.volume} lots cannot "
                    f"be split (min {sym_info.volume_min}). Trailing ladder handles this "
                    f"trade instead.", YELLOW)
            continue

        tick       = mt5.symbol_info_tick(p.symbol)
        close_type = mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY
        close_price = tick.bid if is_buy else tick.ask

        close_req = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "position":     ticket,
            "symbol":       p.symbol,
            "volume":       half_vol,
            "type":         close_type,
            "price":        close_price,
            "deviation":    20,
            "magic":        MAGIC_NUMBER,
            "comment":      "SmartEntry partial 1R",
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(close_req)
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            position_partial_taken.add(ticket)
            log(f"PARTIAL PROFIT: Closed 50% of #{ticket} {p.symbol} @ {close_price:.2f} (+1R)", GREEN + BOLD)
            # Move SL to breakeven
            be_req = {
                "action":   mt5.TRADE_ACTION_SLTP,
                "position": ticket,
                "symbol":   p.symbol,
                "sl":       round(entry, 5),
                "tp":       p.tp,
                "magic":    MAGIC_NUMBER,
            }
            be_result = mt5.order_send(be_req)
            if be_result.retcode == mt5.TRADE_RETCODE_DONE:
                log(f"SL moved to breakeven for #{ticket}", CYAN)
        else:
            log(f"Partial close failed #{ticket}: {result.comment}", RED)


def process_all_signals(data):
    """Process every tradable asset's signal in parallel threads."""
    # max(1, ...) so emptying TRADABLE_KEYS gates all trading rather than raising
    # ValueError out of ThreadPoolExecutor on every poll.
    with ThreadPoolExecutor(max_workers=max(1, len(TRADABLE_KEYS))) as executor:
        futures = {executor.submit(process_signal, key, data.get(key)): key
                   for key in TRADABLE_KEYS}
        for future in futures:
            try:
                future.result(timeout=30)
            except Exception as e:
                log(f"Signal processing error ({futures[future]}): {e}", RED)


def deals_for_position(ticket):
    """Every MT5 deal belonging to exactly this position id. [] when there are none.

    history_deals_get has THREE mutually exclusive calling forms — a date range, an
    order ticket, or a position id. Its own signature says so:
    `history_deals_get([date_from, date_to, [group]],[position=...],[ticket=...])`.
    Passing dates makes MT5 ignore the position keyword entirely and hand back every
    deal in the window. Measured 2026-08-01 on account 25446287, which is shared with
    five foreign EAs (magics 20002, 20003, 903110, 990011, 996142): the dated call
    returned 28 deals, the position-only call returned the 2 that actually belong to
    the position. The position_id re-check costs nothing and makes the regression
    impossible to reintroduce.
    """
    try:
        deals = mt5.history_deals_get(position=ticket)
    except Exception as exc:
        log(f"history lookup for #{ticket} raised: {exc}", YELLOW)
        return []
    if not deals:
        return []
    return [d for d in deals if d.position_id == ticket]


CLOSING_DEAL_ENTRIES = (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)


def summarize_closed_position(deals):
    """Net outcome of one position's deals as (pnl, close_price, close_time_iso).

    Returns None when the list holds no closing deal — the caller must never invent
    an outcome, because a fabricated P&L feeds the circuit breaker and the learning
    engine as if it were real.

    Sums EVERY deal of the position rather than reading one of them: a position that
    took profit at 1R closes in two OUT deals (see take_partial_profit), and reading
    only the first books half the result as the whole. Commission and swap ride on the
    same deals as separate fields and are real money, so they are part of the net.
    """
    if not deals:
        return None
    closing_deals = [d for d in deals if d.entry in CLOSING_DEAL_ENTRIES]
    if not closing_deals:
        return None
    net_pnl = sum(float(d.profit) + float(d.commission) + float(d.swap) for d in deals)
    final_deal = max(closing_deals, key=lambda d: d.time)
    return (
        round(net_pnl, 2),
        float(final_deal.price),
        datetime.fromtimestamp(final_deal.time).isoformat(),
    )


# MT5's OWN answer to "why did this close", which the terminal has always known and this
# bridge was throwing away: summarize_closed_position reads final_deal.price and .time and
# drops .reason.
#
# Measured on this account 2026-08-17: of 1092 closing deals, 1064 carried DEAL_REASON_SL,
# 17 TP, 6 EXPERT, 5 CLIENT. The field is populated and authoritative, which is why the
# price-inference fallback originally proposed (match closePrice against sl/tp within a
# slippage tolerance) is not needed — there is nothing to infer.
#
# STOPOUT is kept separate from STOP deliberately. A margin stop-out is not the setup's
# stop being hit, and folding them together would hide a liquidation inside a normal loss.
# Anything unrecognised becomes OTHER and the raw code travels beside the label, so no
# information is discarded on the way.
EXIT_REASON_BY_DEAL_REASON = {
    mt5.DEAL_REASON_SL: "STOP",
    mt5.DEAL_REASON_TP: "TARGET",
    mt5.DEAL_REASON_SO: "STOPOUT",
}


def exit_reason_for(deals):
    """(label, raw_reason_code) for the deal that actually closed the position.

    (None, None) when there is no closing deal or the terminal reports no reason, so the
    caller records nothing rather than guessing - the same rule summarize_closed_position
    follows, and for the same reason: a fabricated outcome is worse than a missing one.

    Picks the LAST closing deal by time, matching summarize_closed_position, so a position
    that took partial profit at 1R and then stopped out is labelled by how it finally
    ended rather than by its first exit.

    NOTE a STOP is not necessarily a loss. A trailing stop that moved into profit still
    closes with DEAL_REASON_SL, and one such deal on this account shows profit +0.40 -
    so nothing downstream may treat this label as the sign of the P&L.
    """
    if not deals:
        return (None, None)
    closing_deals = [d for d in deals if d.entry in CLOSING_DEAL_ENTRIES]
    if not closing_deals:
        return (None, None)
    final_deal = max(closing_deals, key=lambda d: d.time)
    raw_reason = getattr(final_deal, "reason", None)
    if raw_reason is None:
        return (None, None)
    return (EXIT_REASON_BY_DEAL_REASON.get(raw_reason, "OTHER"), int(raw_reason))


def opened_by_this_bridge(deals, expected_symbol):
    """True when this position's OPENING deal is one of ours.

    Only the IN side is tested. place_order stamps MAGIC_NUMBER on entry, but the
    closing deal frequently carries magic 0 — a stop-out, a TP hit or a manual close
    is not our order — so magic-filtering the OUT side would discard exactly the deals
    that hold the P&L. Symbol is checked too: ticket ids are unique per account, not
    across the fleet, and this is what stops one bridge reporting another account's
    trade as its own.
    """
    for deal in deals:
        if deal.entry != mt5.DEAL_ENTRY_IN:
            continue
        if deal.magic != MAGIC_NUMBER:
            return False
        if expected_symbol and deal.symbol.upper() != str(expected_symbol).upper():
            return False
        return True
    return False


def track_closed_positions():
    """Detect positions that closed since last check and POST to /api/trade-closed."""
    global known_positions

    positions = mt5.positions_get()
    # None is an MT5 error; () is genuinely no open positions. Conflating them makes a
    # dead handle look like "every position closed at once", and each tracked ticket
    # would be written to the journal as closed with an unknown P&L — fictional
    # outcomes that then feed the learning engine.
    if positions is None:
        log(f"positions_get() failed ({mt5.last_error()}) — skipping close detection "
            f"this cycle rather than inferring closes from an error.", YELLOW)
        return

    current_tickets = {p.ticket for p in positions if p.magic == MAGIC_NUMBER}

    closed_tickets = known_positions - current_tickets

    for ticket in closed_tickets:
        pnl         = None
        close_price = None
        close_time  = datetime.now().isoformat()
        # Fetched ONCE and shared. Calling deals_for_position twice would double the
        # history round-trip per close for two readings of the same deals.
        deals = deals_for_position(ticket)
        outcome = summarize_closed_position(deals)
        exit_reason, exit_reason_code = exit_reason_for(deals)
        if outcome:
            pnl, close_price, close_time = outcome
        else:
            # The position is genuinely gone, so the journal must not keep calling it
            # open — post the close with an unknown P&L rather than silently dropping
            # it. Unlike the startup sweep, this path watched the ticket disappear.
            log(f"No closing deal on record for #{ticket} — reporting close with unknown P&L.", YELLOW)

        # Counters and their on-disk copy move together — see record_closed_outcome.
        record_closed_outcome(pnl, close_time)

        try:
            requests.post(f"{SERVER_URL}/api/trade-closed", json={
                "ticket":     ticket,
                "pnl":        pnl,
                "closePrice": close_price,
                "closeTime":  close_time,
                "account":    ACCOUNT_TAG or "default",
                # Record-only. Nothing on the server reads these to decide anything: the
                # learning engine stays P&L-based and no gate, threshold or sizing path
                # touches them. They exist so "hit its stop" can be told from "someone
                # closed it", which the journal could not previously express.
                "exitReason":     exit_reason,
                "exitReasonCode": exit_reason_code,
            }, timeout=JOURNAL_REQUEST_TIMEOUT_S)
            color = GREEN if pnl and pnl > 0 else RED
            log(f"Trade closed #{ticket}  P&L ${pnl}"
                + (f"  exit={exit_reason}" if exit_reason else ""), color)
        except Exception as e:
            log(f"Could not POST trade-closed #{ticket}: {e}", RED)

        try:
            requests.post(f"{SERVER_URL}/api/risk-status", json={
                "dailyPnl": round(daily_pnl, 2),
                "consecutiveLosses": consecutive_losses,
                "halted": trading_halted,
                "haltReason": halt_reason,
                "account": ACCOUNT_TAG or "default",
                # The real limits this bridge is running with. The Auto Trade page
                # used to hardcode these numbers in HTML, so changing the env vars
                # left the dashboard confidently displaying the old ones.
                "config": {
                    "riskPercent":      RISK_PERCENT,
                    "dailyLossPct":     daily_loss_limit,
                    "maxConsecLosses":  MAX_CONSECUTIVE_LOSSES,
                    "maxSpreadPts":     MAX_SPREAD_PTS,
                    "autoMode":         AUTO_MODE,
                    "expectedLogin":    EXPECTED_LOGIN or None,
                },
            }, timeout=3)
        except Exception:
            pass

        # Drop every per-position record together, or the next trade to be handed
        # this ticket id inherits a stale risk figure and a suppressed warning.
        position_initial_r.pop(ticket, None)
        position_partial_taken.discard(ticket)
        trail_unresolved_logged.discard(ticket)
        partial_too_small_logged.discard(ticket)
        save_position_r()

    known_positions = current_tickets


# ── Startup reconciliation ────────────────────────────────────────────────────
# known_positions lives in memory only, and closes are computed as
# `known_positions - current_tickets`. A position that closes while this process is
# DOWN is in neither set, so it is never recorded: the journal keeps it OPEN with a
# null P&L forever, the learning engine never receives the outcome, and the circuit
# breaker never counts the loss. Proven on 2026-07-31: the machine was off from
# 03:37 to 04:52 the next day, gold #1682651222 hit its stop at 12:12:45 inside that
# window, and the journal still calls it open.
#
# The sweep below closes that hole once, before the main loop starts. It is
# idempotent through the server's own state — a reconciled entry comes back from
# /api/journal as status "CLOSED" and is not selected again — so a restart loop can
# never double-count a trade into updateLearning.
JOURNAL_FETCH_LIMIT       = 500
JOURNAL_REQUEST_TIMEOUT_S = 15

# How often the sweep runs AFTER the startup pass.
#
# Running it once was the whole defect. On 2026-08-11 the sweep fired 22 seconds
# after the terminal launched: positions_get() was already correct — #1713655080 and
# #1726672007 really had closed, at 01:53:41Z and 01:54:13Z, 83 minutes earlier —
# but history_deals_get(position=...) returned only the OPENING deal for each,
# because the terminal downloads trade history from the broker asynchronously and
# had not finished. summarize_closed_position() saw no closing deal, correctly
# refused to invent a P&L, and nothing ever asked again. Nineteen minutes later the
# identical query returned both closing deals in full. A +135.91 win — the first
# this system has ever had — and a -99.10 loss the breaker never counted sat in the
# journal as OPEN with a null P&L.
#
# Repeating it also makes the sweep a standing backstop under track_closed_positions(),
# whose known_positions set is in memory: a close that slips past the live diff is now
# picked up on the next pass instead of being lost for good.
RECONCILE_INTERVAL_S = 300

# Tickets already reported as unresolvable, so a retry every 5 minutes does not
# reprint the same warning forever. Cleared per ticket the moment it reconciles.
reconcile_warned = set()


def fetch_open_journal_entries():
    """Journal entries the server still believes are open. [] on any failure.

    Empty rather than raising: the server being unreachable at startup is a reason to
    skip reconciliation, never a reason to stop the bridge from trading.
    """
    try:
        res = requests.get(
            f"{SERVER_URL}/api/journal",
            params={"limit": JOURNAL_FETCH_LIMIT},
            timeout=JOURNAL_REQUEST_TIMEOUT_S,
        )
        res.raise_for_status()
        entries = res.json().get("journal")
    except Exception as exc:
        log(f"Journal unreachable ({exc}) — skipping startup reconciliation.", YELLOW)
        return []
    if not isinstance(entries, list):
        log("Journal response carried no entry list — skipping startup reconciliation.", YELLOW)
        return []
    return [e for e in entries if isinstance(e, dict) and e.get("status") == "OPEN"]


def journal_entry_is_ours(journal_entry, deals):
    """Does this open journal entry belong to THIS bridge's account?

    Two independent tests, because neither is sufficient alone. The `account` field is
    authoritative when present, but /api/trade-opened never persists one, so every
    entry written to date lacks it and matching on it alone would reconcile nothing.
    MT5 history is the standing proof: a ticket this account never held returns no
    deals at all, and one it did hold returns an opening deal carrying our magic.
    """
    entry_account = journal_entry.get("account")
    if entry_account and entry_account != (ACCOUNT_TAG or "default"):
        return False
    return opened_by_this_bridge(deals, journal_entry.get("symbol"))


def report_reconciled_close(ticket, outcome):
    """POST one recovered close to the server. True when the server accepted it."""
    pnl, close_price, close_time = outcome
    try:
        res = requests.post(f"{SERVER_URL}/api/trade-closed", json={
            "ticket":     ticket,
            "pnl":        pnl,
            "closePrice": close_price,
            "closeTime":  close_time,
            "account":    ACCOUNT_TAG or "default",
        }, timeout=JOURNAL_REQUEST_TIMEOUT_S)
        res.raise_for_status()
    except Exception as exc:
        log(f"Could not report recovered close #{ticket}: {exc}", RED)
        return False
    log(f"RECOVERED close #{ticket}  P&L ${pnl:.2f} @ {close_price} ({close_time})",
        GREEN if pnl > 0 else RED)
    return True


def reconcile_open_trades():
    """Record trades that ended while this bridge was not running.

    Closes newer than the last one already counted DO feed the breaker, gated on
    last_counted_close. The original objection still stands — replaying a week of
    history into a day-scoped counter would halt a freshly started bridge on a loss
    limit it never incurred — and it is answered by that gate plus the per-day
    scoping in record_closed_outcome, not by excluding these outcomes altogether.
    Excluding them was the worse bug: a loss that lands while the bridge is down is
    precisely the kind the breaker exists to catch, and #1682651222 reached the
    journal and the learning engine while the breaker never saw it.
    """
    open_entries = fetch_open_journal_entries()
    if not open_entries:
        return

    positions = mt5.positions_get()
    live_tickets = {p.ticket for p in positions} if positions else set()

    recovered = 0
    for journal_entry in open_entries:
        try:
            ticket = int(journal_entry.get("ticket"))
        except (TypeError, ValueError):
            continue
        if ticket in live_tickets:
            continue  # still open — nothing to reconcile

        # One history lookup per ticket, shared by the ownership test and the P&L
        # maths below. Empty means this terminal holds nothing for that id: on a
        # multi-account fleet that is the normal answer for another bridge's trade,
        # so it is stated plainly rather than warned about.
        deals = deals_for_position(ticket)
        if not deals:
            log(f"#{ticket} ({journal_entry.get('symbol')}) reads OPEN but this account "
                f"holds no deals for it — not reconciling.", CYAN)
            continue
        if not journal_entry_is_ours(journal_entry, deals):
            continue  # another account's ticket, or a foreign EA's

        outcome = summarize_closed_position(deals)
        if outcome is None:
            # A position that is not open MUST have a closing deal somewhere, so
            # this is history that has not downloaded yet rather than a trade with
            # no ending. Say so once and let the next sweep ask again — the earlier
            # wording ("leaving it for a human") described a one-shot check and was
            # true of one, but no human was ever told.
            if ticket not in reconcile_warned:
                log(f"#{ticket} ({journal_entry.get('symbol')}) is ours and no longer open, "
                    f"but MT5 has not returned a closing deal for it yet — trade history is "
                    f"still downloading. Retrying every {RECONCILE_INTERVAL_S}s.", YELLOW)
                reconcile_warned.add(ticket)
            continue
        if report_reconciled_close(ticket, outcome):
            recovered += 1
            reconcile_warned.discard(ticket)
            reconciled_pnl, _, reconciled_close_time = outcome
            # Only what the breaker has not already seen. Without this gate every
            # restart would re-fold the same history into the streak; with it,
            # exactly the closes that happened during the outage are counted.
            if reconciled_close_time > last_counted_close:
                record_closed_outcome(reconciled_pnl, reconciled_close_time)

    if recovered:
        log(f"Startup reconciliation recorded {recovered} close(s) missed while offline.", CYAN)


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    print(f"\n{CYAN}{BOLD}SmartEntry MT5 Bridge v1{RESET}")
    print(f"Mode: {'AUTO (min strength: ' + strategy_settings['minStrength'] + ')' if AUTO_MODE else 'SEMI-AUTO (confirm each trade)'}")
    print(f"Risk per trade: {RISK_PERCENT}%  |  Max spread: {MAX_SPREAD_PTS} pts")
    print(f"Server: {SERVER_URL}")
    print(f"Poll interval: {POLL_INTERVAL}s")
    if ACCOUNT_TAG:
        print(f"Account tag: {ACCOUNT_TAG}")
    print(f"Terminal: {TERMINAL_PATH or '(auto-detect — unsafe with more than one MT5 terminal running)'}\n")

    # On a cold boot (auto-logon just fired, terminal launched seconds ago), MT5 can take
    # longer to become IPC-ready than a warm restart — a single failed attempt used to kill
    # the whole bridge permanently, with nothing (not even the watchdog) able to bring it
    # back, since "never connected yet" is deliberately not treated as a failure state.
    CONNECT_RETRIES = 6
    CONNECT_RETRY_DELAY_S = 15
    connected = False
    for attempt in range(1, CONNECT_RETRIES + 1):
        if connect_mt5():
            connected = True
            break
        if attempt < CONNECT_RETRIES:
            log(f"Connect attempt {attempt}/{CONNECT_RETRIES} failed — retrying in {CONNECT_RETRY_DELAY_S}s (MT5 may still be starting up)…", YELLOW)
            time.sleep(CONNECT_RETRY_DELAY_S)

    if not connected:
        log(f"Could not connect after {CONNECT_RETRIES} attempts — giving up.", RED)
        sys.exit(1)

    # Settle the books BEFORE seeding known_positions, so anything that closed while
    # this process was down is recorded rather than quietly written off. Wrapped
    # because a reconciliation failure must never keep the bridge from trading.
    global known_positions

    # Restore the breaker BEFORE reconciliation runs, so last_counted_close is known
    # and the sweep can tell an outage close from history it has already counted.
    load_breaker_state()

    # Before the first manage_trailing_stops() call, so a position whose stop this
    # bridge already moved is measured against its TRUE risk rather than against the
    # stop the last run left behind.
    load_position_r()

    # The startup pass is kept because it is the only one that runs BEFORE
    # known_positions is seeded, but it is no longer the only pass — see
    # RECONCILE_INTERVAL_S. At this moment the terminal has been up for seconds and
    # its trade history may still be downloading, so this call is expected to come
    # up empty sometimes; the loop below is what makes that harmless.
    try:
        reconcile_open_trades()
    except Exception as exc:
        log(f"Startup reconciliation failed ({exc}) — continuing without it.", YELLOW)
    last_reconcile_at = time.time()

    # Adopt the positions already running under our magic, so the first loop sees them
    # as open rather than as a fresh set to diff against nothing.
    startup_positions = mt5.positions_get()
    known_positions = {p.ticket for p in startup_positions if p.magic == MAGIC_NUMBER} \
        if startup_positions else set()
    if known_positions:
        log(f"Tracking {len(known_positions)} open SmartEntry position(s): "
            f"{', '.join('#' + str(t) for t in sorted(known_positions))}", CYAN)

    log("Bridge started — watching for signals…", GREEN)

    # WHO THIS PROCESS IS, because Windows will not say.
    #
    # Get-CimInstance returns an EMPTY CommandLine for these python processes — verified
    # 2026-08-17, two of them, both `cmd=[]`, identical creation times — and one of the two
    # is the shim. So nothing on the laptop could tell Bridge A from Bridge B from an
    # unrelated script, and tasks/safe_bridge_restart.cjs had no safe way to cycle a bridge
    # here at all: it fell back to a scheduled task that only exists on the VPS. Killing by
    # guess on a process that trades is not an option, so the bridge names itself instead.
    #
    # Tag-scoped, so two bridges never overwrite each other's file. Written AFTER the MT5
    # connection is up, so the file's existence means a bridge that actually reached the
    # terminal, not one that died initialising. Never cleaned up on exit: a stale file is
    # harmless because every reader must re-verify the pid is a live python process anyway,
    # whereas deleting it on a crash path that may not run would be a false absence.
    #
    # Best-effort by design. A bridge that cannot write a diagnostic file must still trade.
    try:
        pid_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "tasks", "logs", f"bridge_{ACCOUNT_TAG or 'default'}.pid")
        os.makedirs(os.path.dirname(pid_path), exist_ok=True)
        with open(pid_path, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
        log(f"Bridge pid {os.getpid()} recorded at {os.path.relpath(pid_path)}", CYAN)
    except Exception as exc:
        log(f"Could not record bridge pid ({exc}) — restart tooling will fall back to "
            f"refusing rather than guessing.", YELLOW)

    # Push once before the first signal fetch so the server's very first refresh
    # already has MT5 bars rather than spending a cycle on the Yahoo fallback.
    push_candles(force=True)

    while True:
        try:
            # Read the kill switch BEFORE looking at signals, so a halt takes effect
            # on the very next cycle rather than one cycle late. Existing positions
            # are still managed below either way — a halt stops new entries, it does
            # not abandon open trades.
            # Everything below needs a working MT5 handle, and a handle can die
            # silently mid-session. Skip the cycle rather than run the whole loop
            # against a terminal that is no longer there.
            if not ensure_mt5_connection():
                time.sleep(POLL_INTERVAL)
                continue
            check_remote_control()
            refresh_strategy_settings()
            # Before fetching signals, so the bars the server is about to compute
            # from are the freshest this bridge has seen.
            push_candles()
            data = fetch_signals()
            if data:
                print_status(data)
                process_all_signals(data)
            report_positions()
            report_risk_status()
            manage_trailing_stops()
            take_partial_profit()
            track_closed_positions()

            # Settle anything the live diff above could not see. track_closed_positions()
            # compares against an IN-MEMORY set, so it is blind to a trade that ended
            # while this process was down, and the startup sweep may have run before
            # MT5 finished downloading history. This is the pass that catches both.
            if time.time() - last_reconcile_at >= RECONCILE_INTERVAL_S:
                last_reconcile_at = time.time()
                try:
                    reconcile_open_trades()
                except Exception as exc:
                    log(f"Reconciliation sweep failed ({exc}) — will retry.", YELLOW)
        except KeyboardInterrupt:
            log("Shutting down MT5 bridge…", YELLOW)
            mt5.shutdown()
            sys.exit(0)
        except Exception as e:
            log(f"Loop error: {e}", RED)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
