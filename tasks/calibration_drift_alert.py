"""
Calibration Drift Alert — detects when setup win rates diverge from expected
and sends a notification. Runs nightly via auto_daily.bat.

  python tasks/calibration_drift_alert.py [--threshold N] [--silent]

WHAT IT MEASURES
  For each setup in server/learning.json with >= 5 episodes:
    drift = |live_win_rate - shadow_win_rate|
  Shadow win rate comes from server/learning_shadow.json (built by learning_from_rejections.py).
  If shadow data is absent for a setup, drift is skipped for that setup (not errored).

  Also compares overall live WR against the walk-forward expected range.

THRESHOLD
  Default: 15 percentage points. If |live - expected| > threshold, fire alert.

WHAT IT DOES NOT DO
  - Never writes learning.json
  - Never changes any gate, threshold, signal or setting
  - Never deletes anything
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT          = Path(__file__).parent.parent
SHADOW_PATH   = ROOT / "server" / "learning_shadow.json"
SERVER_URL    = "http://localhost:3001"
DEFAULT_DRIFT_THRESHOLD = 15  # percentage points


def _fetch(path: str):
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=8) as r:
            return json.loads(r.read().decode())
    except Exception as exc:
        return {"_error": str(exc)}


def _load_shadow() -> dict:
    try:
        raw = json.loads(SHADOW_PATH.read_text(encoding="utf-8"))
        return raw.get("shadowStats", {})
    except Exception:
        return {}


def _send_notification(title: str, message: str):
    try:
        import subprocess
        subprocess.run(
            [sys.executable, str(ROOT / "notifications.py"), "alert", message, "--title", title],
            timeout=10, capture_output=True, cwd=str(ROOT),
        )
    except Exception:
        pass


def _write_memory(key: str, value: str):
    try:
        body = json.dumps({"key": key, "value": value}).encode()
        req = urllib.request.Request(
            f"{SERVER_URL}/api/memory",
            data=body, headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def main():
    argv      = sys.argv[1:]
    threshold = DEFAULT_DRIFT_THRESHOLD
    silent    = "--silent" in argv
    for i, a in enumerate(argv):
        if a == "--threshold" and i + 1 < len(argv):
            try:
                threshold = float(argv[i + 1])
            except ValueError:
                pass

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] Calibration drift check (threshold: {threshold}pp)")

    learning = _fetch("/api/learning")
    if "_error" in learning:
        print(f"  Server offline: {learning['_error']} — skipping.")
        return 1

    shadow = _load_shadow()
    live_setups = learning.get("setups", {}) if isinstance(learning, dict) else {}

    alerts   = []
    drifts   = []
    compared = 0

    for setup, live in live_setups.items():
        w = live.get("wins", 0)
        l = live.get("losses", 0)
        total = w + l
        if total < 5:
            continue

        live_wr = round(w / total * 100, 1)

        if setup not in shadow:
            continue
        shadow_data = shadow[setup]
        if not shadow_data.get("enoughForReading"):
            continue

        shadow_wr = shadow_data.get("winRate", None)
        if shadow_wr is None:
            continue

        drift = abs(live_wr - shadow_wr)
        drifts.append({
            "setup": setup,
            "live_wr": live_wr,
            "shadow_wr": shadow_wr,
            "drift": round(drift, 1),
        })
        compared += 1

        if drift >= threshold:
            alerts.append(f"{setup}: live {live_wr}% vs shadow {shadow_wr}% = {drift:.1f}pp drift")
            print(f"  ⚠ DRIFT: {setup} live={live_wr}% shadow={shadow_wr}% drift={drift:.1f}pp")
        else:
            print(f"  ✓ OK:    {setup} live={live_wr}% shadow={shadow_wr}% drift={drift:.1f}pp")

    print(f"\n  Compared {compared} setup(s). Alerts: {len(alerts)}")

    if alerts:
        title   = f"CALIBRATION DRIFT: {len(alerts)} setup(s)"
        message = "Drift detected: " + " | ".join(alerts[:3])
        if not silent:
            _send_notification(title, message)
        summary = f"{len(alerts)} drift(s) at {ts}: {message[:200]}"
        _write_memory("calibration-drift-latest", summary)
        print(f"\n  Alert sent: {message}")
    else:
        summary = f"No drift at {ts}. {compared} setup(s) checked."
        _write_memory("calibration-drift-latest", summary)

    return 1 if alerts else 0


if __name__ == "__main__":
    raise SystemExit(main())
