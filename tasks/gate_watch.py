"""
Alert when an asset CROSSES the confidence gate.

  python tasks/gate_watch.py            check once and alert on any crossing
  python tasks/gate_watch.py --dry-run  report what it would send, send nothing
  python tasks/gate_watch.py --status   print the remembered state and exit

WHY THIS EXISTS
notifications.py has had notify_signal() and a `signal` CLI command since it was written,
and NOTHING HAS EVER CALLED THEM. Same shape as tradingview_bot's login(): a capability
that is present, correct, wired to real credentials, and invoked from nowhere. So the
system has computed a gate-clearing signal, written it to /api/signals, and told no one.

WHAT IT ALERTS ON, AND WHAT IT DELIBERATELY DOES NOT
Only a TRANSITION: an asset that was below the gate and is now at or above it. Not on
every poll - this runs every few minutes and an alert that repeats is an alert that gets
muted, which is worse than no alert because the muting is silent and permanent.

State lives in tasks/.gate_watch_state.json so a restart does not re-announce a signal
that was already sent. When an asset falls back below the gate its state is cleared, so
the NEXT crossing alerts again.

IT CHANGES NOTHING. It reads /api/signals and /api/strategy-settings, and shells out to
notifications.py. It does not place, size, modify or close a trade, and it does not touch
a threshold. The worst it can do is send a message.

THE GATE IS READ LIVE, NEVER HARDCODED. strategy_settings.json is per-machine and the
gate has moved twice this month; a watcher carrying its own copy would alert against a
threshold the engine is not using. If the settings read fails, it does NOT fall back to a
guess - it says so and exits without alerting, because a crossing computed against the
wrong gate is a false alarm and false alarms are how alerting dies.
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass

ROOT = Path(__file__).parent.parent
STATE_FILE = ROOT / "tasks" / ".gate_watch_state.json"
BASE = "http://localhost:3001"
ASSETS = {"BTC": "btc", "GOLD": "gold", "SPX": "spx"}


def get_json(path, timeout=12):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except Exception as exc:
        print(f"[gate] {path} failed: {exc}")
        return None


def read_state():
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        # An unreadable state file must not silence the watcher. Treating it as empty
        # risks ONE duplicate alert; treating it as "already alerted" would lose a real
        # signal, and losing the signal is the failure that matters.
        print(f"[gate] state unreadable ({exc}) - treating as empty")
    return {}


def write_state(state):
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"[gate] could not record state ({exc}) - the next run may repeat an alert")


def send(symbol, direction, confidence, summary):
    """Hand off to notifications.py, which owns every channel and its formatting."""
    cmd = [sys.executable, str(ROOT / "notifications.py"), "signal",
           symbol, direction, str(confidence), summary]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if result.returncode != 0:
            print(f"[gate] notification FAILED rc={result.returncode}: "
                  f"{(result.stderr or result.stdout or '').strip()[:200]}")
            return False
        return True
    except Exception as exc:
        print(f"[gate] notification could not run: {exc}")
        return False


def main():
    argv = sys.argv[1:]
    dry_run = "--dry-run" in argv

    state = read_state()
    if "--status" in argv:
        print(json.dumps(state, indent=2) if state else "  no state recorded yet")
        return 0

    settings = get_json("/api/strategy-settings")
    if not isinstance(settings, dict) or not isinstance(settings.get("confidenceThreshold"), (int, float)):
        print("[gate] REFUSING: the live gate could not be read. Not alerting against a "
              "guessed threshold - a false alarm is how alerting gets muted.")
        return 2
    gate = settings["confidenceThreshold"]
    if settings.get("settingsError"):
        print(f"[gate] WARNING: settingsError is set ({settings['settingsError']}) - the "
              f"server is on BUILT-IN DEFAULTS, so gate {gate} may not be the saved config.")

    signals = get_json("/api/signals")
    if not isinstance(signals, dict):
        print("[gate] REFUSING: /api/signals unavailable")
        return 2

    crossings = 0
    for name, key in ASSETS.items():
        asset = signals.get(key)
        if not isinstance(asset, dict):
            continue
        confidence = asset.get("confidence")
        if not isinstance(confidence, (int, float)):
            continue

        at_or_above = confidence >= gate
        was_armed = bool(state.get(name, {}).get("armed"))

        if at_or_above and not was_armed:
            crossings += 1
            direction = str(asset.get("signal") or "?").upper()
            setup = asset.get("setup") or "-"
            entry, stop, target = asset.get("entry"), asset.get("stop"), asset.get("target")
            summary = (f"{setup} on {asset.get('setupTimeframe', '?')}. "
                       f"Entry {entry}  Stop {stop}  Target {target}. "
                       f"Confidence {confidence} vs gate {gate}.")
            print(f"[gate] CROSSING: {name} {direction} {confidence} >= {gate}")
            if dry_run:
                print(f"       would send: {summary}")
                continue
            if send(name, direction, confidence, summary):
                state[name] = {"armed": True, "confidence": confidence,
                               "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            else:
                # Do NOT mark armed on a failed send, or the retry never happens and the
                # signal is lost silently - which is the whole failure this guards against.
                print(f"[gate] {name} NOT marked armed - it will retry next run")

        elif not at_or_above and was_armed:
            # Cleared, so the next genuine crossing alerts again.
            print(f"[gate] {name} fell back below the gate ({confidence} < {gate}) - rearmed")
            state.pop(name, None)

    if not dry_run:
        write_state(state)
    if crossings == 0:
        print(f"[gate] no crossings. gate {gate}; "
              + ", ".join(f"{n} {signals.get(k, {}).get('confidence', '?')}"
                          for n, k in ASSETS.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
