"""Tests for the circuit breaker's cooldown release.

The defect this covers: consecutive_losses reset in exactly one place — a winning
close — while the halt blocked the entries that could produce one. Once every open
position closed with the streak at the cap, no trade could open, no win could occur,
and the streak could never clear. The box stayed dead until a human noticed, and the
box that trades continuously is headless.

The release that fixes it is the dangerous kind of code: it resumes trading with no
human in the loop. So every boundary is asserted in BOTH directions — that it releases
when it should, and that it refuses to when it should not. A test suite that only
proves the happy path would be worse than none here.

mt5_bridge imports MetaTrader5, which is not importable everywhere and connects to a
terminal when it is, so the module is loaded with a stub in sys.modules. Nothing here
touches a broker, a position, or the live state file.

Run: python tasks/breaker_cooldown_test.py
"""

import os
import sys
import json
import types
import tempfile
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# Stub MetaTrader5 before mt5_bridge imports it. account_info returns None by default,
# which is the "MT5 unreachable" path — check_circuit_breaker must survive it.
_stub = types.ModuleType("MetaTrader5")
_stub.account_info = lambda: None
_stub.initialize = lambda *a, **k: False
_stub.shutdown = lambda: None
_stub.symbols_get = lambda *a, **k: []
_stub.positions_get = lambda *a, **k: ()
_stub.history_deals_get = lambda *a, **k: ()

# mt5_bridge reads module-level constants at import (CLOSING_DEAL_ENTRIES, the
# TIMEFRAME_* values, the retcodes). Enumerating them here by hand would mean this
# harness breaks every time the bridge references one more, so the stub completes
# itself: any unknown name becomes a distinct integer, which is what these constants
# are. Distinct matters — several are compared against each other.
_sentinels = {}


def _missing(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return _sentinels.setdefault(name, 900000 + len(_sentinels))


_stub.__getattr__ = _missing
sys.modules.setdefault("MetaTrader5", _stub)

# A scratch state file, so the real breaker_state_A.json is never read or written.
_scratch = tempfile.mkdtemp(prefix="breaker-cooldown-test-")
os.environ["HALT_COOLDOWN_HOURS"] = "48"

import mt5_bridge as b  # noqa: E402

b.BREAKER_STATE_PATH = os.path.join(_scratch, "breaker_state_TEST.json")

passed, failed = 0, 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + (("\n          " + detail) if detail else ""))


def reset(streak=0, halted=False, cause="", hours_ago=None, cooldown=48.0):
    """Put the breaker in a known state. hours_ago=None means no halt timestamp."""
    b.consecutive_losses = streak
    b.trading_halted = halted
    b.halt_reason = "test" if halted else ""
    b.halt_cause = cause
    b.halted_at = ""
    if hours_ago is not None:
        b.halted_at = (datetime.utcnow() - timedelta(hours=hours_ago)).isoformat() + "Z"
    b.HALT_COOLDOWN_HOURS = cooldown
    b.daily_pnl = 0.0


print("\n-- it releases when it should ------------------------------------")

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=49)
released = b.release_streak_halt_if_cooled()
check("a streak halt past its cooldown is released", released)
check("and the streak DECAYS rather than resetting", b.consecutive_losses == 2,
      "expected 2 (3 - 1), got %r" % b.consecutive_losses)
check("and trading is live again", b.trading_halted is False)
check("and the halt timestamp is cleared", b.halted_at == "" and b.halt_cause == "")

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=49)
b.release_streak_halt_if_cooled()
check("released at MAX-1, so ONE more loss re-halts",
      b.consecutive_losses == b.MAX_CONSECUTIVE_LOSSES - 1)


print("\n-- it refuses when it should ------------------------------------")

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=47)
check("one hour short of the cooldown, the halt STANDS",
      b.release_streak_halt_if_cooled() is False and b.trading_halted is True)

reset(streak=3, halted=True, cause=b.HALT_CAUSE_DAILY_LOSS, hours_ago=200)
check("a DAILY-LOSS halt is never released by this timer, however old",
      b.release_streak_halt_if_cooled() is False and b.trading_halted is True,
      "the daily limit is supposed to last the day; the day-rollover path owns it")

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=200, cooldown=0)
check("HALT_COOLDOWN_HOURS=0 disables the release entirely",
      b.release_streak_halt_if_cooled() is False and b.trading_halted is True)

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=None)
check("a halt with NO timestamp is not released",
      b.release_streak_halt_if_cooled() is False and b.trading_halted is True,
      "missing clock must mean 'no opinion', never 'release now'")

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=200)
b.halted_at = "not-a-timestamp"
check("an UNREADABLE timestamp leaves the halt standing",
      b.release_streak_halt_if_cooled() is False and b.trading_halted is True,
      "failing open on a parse error would resume trading on corrupt state")

reset(streak=0, halted=False)
check("a box that is not halted is not 'released'",
      b.release_streak_halt_if_cooled() is False)


print("\n-- the human's halt outranks the timer ---------------------------")

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=49)
b.remote_halted = True
b.remote_halt_reason = "stopped by hand"
b.release_streak_halt_if_cooled()
check("releasing the streak halt does NOT clear a remote halt",
      b.remote_halted is True,
      "a timer that can overrule a person is worse than the bug being fixed")
b.remote_halted = False
b.remote_halt_reason = ""


print("\n-- the halt is set eagerly, with a clock ------------------------")

reset(streak=3, halted=False)
b.check_circuit_breaker()
check("reaching the cap sets the halt even with MT5 unreachable",
      b.trading_halted is True,
      "account_info() returns None in this harness; the streak check must still run")
check("and stamps the cause as STREAK", b.halt_cause == b.HALT_CAUSE_STREAK)
check("and starts the clock", bool(b.halted_at))
check("and the remaining cooldown is reported",
      b.halt_cooldown_remaining_seconds() is not None
      and b.halt_cooldown_remaining_seconds() > 47 * 3600)

reset(streak=1, halted=False)
b.check_circuit_breaker()
check("a streak below the cap does NOT halt", b.trading_halted is False)


print("\n-- a loss trips it in the same moment it lands -------------------")

reset(streak=2, halted=False)
b.record_closed_outcome(-10.0, datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"))
check("the third loss halts on the CLOSE, not on the next trade attempt",
      b.trading_halted is True and b.consecutive_losses == 3,
      "this is the whole point: halted:false while at the cap is what misled every surface")

reset(streak=2, halted=False)
b.record_closed_outcome(50.0, datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"))
check("a WIN clears the streak and does not halt",
      b.trading_halted is False and b.consecutive_losses == 0)

reset(streak=2, halted=False)
b.record_closed_outcome(None, datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"))
check("an unmeasurable close moves nothing",
      b.consecutive_losses == 2 and b.trading_halted is False,
      "a null P&L must not be read as a win that clears the streak")


print("\n-- a RESTART at the cap halts without waiting for a trade --------")

# The gap the first version of this fix left. Making the halt eager on the CLOSE path
# covers a loss that lands while the bridge is up. It does NOT cover a bridge that
# restarts with the streak already at the cap: no close, no trade attempt, and the
# restored state says halted:false because that is what was persisted. The VPS came
# back at 3 of 3 still reporting halted:false and this is the case that proves it.
reset(streak=3, halted=False)
b.save_breaker_state()
reset(streak=0, halted=False)
b.load_breaker_state()
check("state restored at the cap, not yet halted (the starting condition)",
      b.consecutive_losses == 3 and b.trading_halted is False)
b.report_risk_status()
check("the per-cycle report halts a box restored AT the cap",
      b.trading_halted is True,
      "no close and no trade attempt happens here — the cycle itself must re-derive it")
check("and it is labelled a STREAK halt with a clock running",
      b.halt_cause == b.HALT_CAUSE_STREAK and bool(b.halted_at))

reset(streak=1, halted=False)
b.report_risk_status()
check("a per-cycle report does NOT invent a halt below the cap",
      b.trading_halted is False)

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=49)
b.report_risk_status()
check("the per-cycle report also RELEASES a cooled halt",
      b.trading_halted is False and b.consecutive_losses == 2)


print("\n-- the cooldown survives a restart -------------------------------")

reset(streak=3, halted=True, cause=b.HALT_CAUSE_STREAK, hours_ago=2)
stamped = b.halted_at
b.save_breaker_state()
with open(b.BREAKER_STATE_PATH, "r", encoding="utf-8") as fh:
    on_disk = json.load(fh)
check("haltedAt and haltCause are persisted",
      on_disk.get("haltedAt") == stamped and on_disk.get("haltCause") == b.HALT_CAUSE_STREAK,
      "without these the cooldown restarts on every bridge restart, and a restart is "
      "the most likely thing to happen during one")

# Wipe the in-memory state, then reload from that file, as a real restart would.
reset(streak=0, halted=False)
b.load_breaker_state()
check("a restart resumes the SAME cooldown, not a fresh one",
      b.halted_at == stamped and b.trading_halted is True)
left = b.halt_cooldown_remaining_seconds()
check("with roughly 46h left, not 48",
      left is not None and 45.5 * 3600 < left < 46.5 * 3600,
      "got %r hours" % (left / 3600 if left else None))

# A state file written before haltedAt existed.
legacy = dict(on_disk)
legacy.pop("haltedAt", None)
legacy.pop("haltCause", None)
with open(b.BREAKER_STATE_PATH, "w", encoding="utf-8") as fh:
    json.dump(legacy, fh)
reset(streak=0, halted=False)
b.load_breaker_state()
legacy_left = b.halt_cooldown_remaining_seconds()
check("a LEGACY halt with no clock serves a full cooldown from now, not zero",
      b.trading_halted is True and legacy_left is not None and legacy_left > 47.5 * 3600,
      "reading a missing timestamp as epoch-zero would turn an upgrade into an "
      "unannounced resumption of trading")

print("\n" + ("%d passed, 0 failed" % passed if failed == 0
              else "%d passed, %d FAILED" % (passed, failed)))
sys.exit(0 if failed == 0 else 1)
