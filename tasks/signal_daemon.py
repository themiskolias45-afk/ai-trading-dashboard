"""
Signal Alert Daemon — watches /api/signals every 60s and pushes a notification
when any asset crosses the live confidence gate.

Runs 24/7 without an open JARVIS session. Start it as a background process:
  python tasks/signal_daemon.py

Or schedule via Windows Task Scheduler:
  python C:/Users/User/ai-trading-dashboard/tasks/signal_daemon.py

What it does:
  - Polls /api/signals every 60s
  - Reads the live gate from /api/strategy-settings (never hardcodes it)
  - Sends a push notification when confidence >= gate for any asset
  - Deduplicates: only fires once per signal (tracks last-fired updatedAt)
  - Backs off to 5min polling if server is offline, resumes on recovery
  - Writes last signal state to tasks/signal_daemon_state.json for inspection

What it does NOT do:
  - Execute trades (that is the bridge's job)
  - Read or write learning.json, journal, or any trading data
"""

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT       = Path(__file__).parent.parent
STATE_PATH = ROOT / "tasks" / "signal_daemon_state.json"
SERVER_URL = "http://localhost:3001"

POLL_INTERVAL    = 60     # seconds between polls when server is healthy
BACKOFF_INTERVAL = 300    # seconds to wait when server is offline
STARTUP_DELAY    = 5      # seconds before first poll (let server settle)


def _fetch(path: str):
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=8) as r:
            return json.loads(r.read().decode())
    except Exception as exc:
        return {"_error": str(exc)}


def _send_notification(title: str, message: str):
    """Best-effort push notification via notifications.py. Silently skips if unavailable."""
    try:
        import subprocess
        subprocess.run(
            [sys.executable, str(ROOT / "notifications.py"), "alert", message, "--title", title],
            timeout=10, capture_output=True, cwd=str(ROOT),
        )
    except Exception:
        pass


def _load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(state: dict):
    try:
        STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception:
        pass


def _log(msg: str):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


def poll_once(state: dict) -> tuple[bool, dict]:
    """
    One poll cycle. Returns (server_ok, updated_state).
    Mutates nothing; caller writes state.
    """
    signals_raw  = _fetch("/api/signals")
    settings_raw = _fetch("/api/strategy-settings")

    if "_error" in signals_raw or "_error" in settings_raw:
        return False, state

    gate = settings_raw.get("confidenceThreshold", 70)
    fired_this_poll = []

    for asset_key, signal in signals_raw.items():
        if not isinstance(signal, dict):
            continue

        asset      = signal.get("symbol") or asset_key
        confidence = signal.get("confidence", 0)
        direction  = signal.get("signal", "")
        updated_at = signal.get("updatedAt", "")
        entry      = signal.get("entry")
        stop       = signal.get("stop")

        if confidence < gate:
            continue
        if not direction or direction.upper() == "WAIT":
            continue

        # Deduplicate by updatedAt — only fire once per unique signal timestamp
        last_key = f"last_fired_{asset_key}"
        if state.get(last_key) == updated_at:
            continue

        # New signal above gate — fire notification
        entry_str = f" Entry ${entry:,.2f}" if entry else ""
        stop_str  = f" Stop ${stop:,.2f}" if stop else ""
        title     = f"SIGNAL: {asset} {direction.upper()} {confidence}%"
        message   = f"{asset} {direction.upper()} at {confidence}% confidence (gate {gate}%).{entry_str}{stop_str}"

        _send_notification(title, message)
        _log(f"ALERT: {message}")

        state[last_key] = updated_at
        fired_this_poll.append(asset)

    state["last_poll"] = datetime.now(timezone.utc).isoformat()
    state["gate"]      = gate

    if fired_this_poll:
        state["last_fire"] = {
            "ts":     datetime.now(timezone.utc).isoformat(),
            "assets": fired_this_poll,
        }

    return True, state


def main():
    _log(f"Signal daemon starting. Server: {SERVER_URL} | Poll: {POLL_INTERVAL}s")
    time.sleep(STARTUP_DELAY)

    state    = _load_state()
    offline  = False
    interval = POLL_INTERVAL

    while True:
        ok, state = poll_once(state)
        _save_state(state)

        if not ok:
            if not offline:
                _log(f"Server offline — backing off to {BACKOFF_INTERVAL}s polling.")
                offline  = True
                interval = BACKOFF_INTERVAL
        else:
            if offline:
                _log("Server back online — resuming normal polling.")
                offline  = False
                interval = POLL_INTERVAL

        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _log("Signal daemon stopped by user.")
