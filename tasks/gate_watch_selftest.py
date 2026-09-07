"""
Selftest for gate_watch: prove it alerts ONCE on a crossing, stays quiet while the
signal persists, and re-arms after it falls back.

  python tasks/gate_watch_selftest.py

Runs entirely on stubs. It never calls the live API, never sends a notification, and
writes its state to a temp file - the real .gate_watch_state.json is untouched, so
running this cannot cause a real signal to be missed or re-announced.

WHY IT EXISTS: the only path exercised against the live system is "no crossing", because
nothing has been above the gate while this was built. An alerting rule that has never
been observed to alert is not a tested rule, and the failure mode is silent - you find
out it was broken by NOT getting the message that mattered.
"""
import json
import sys
import tempfile
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass

sys.path.insert(0, str(Path(__file__).parent))
import gate_watch  # noqa: E402

SENT = []
FAKE = {"gate": 70, "btc": 0, "gold": 0, "spx": 0}


def fake_get_json(path, timeout=12):
    if path == "/api/strategy-settings":
        return {"confidenceThreshold": FAKE["gate"], "settingsError": None}
    if path == "/api/signals":
        return {
            key: {"confidence": FAKE[key], "signal": "BUY", "setup": "TEST",
                  "setupTimeframe": "H4", "entry": 1, "stop": 0.9, "target": 1.2}
            for key in ("btc", "gold", "spx")
        }
    return None


def fake_send(symbol, direction, confidence, summary):
    SENT.append((symbol, confidence))
    return True


def run(label, expect_sent):
    SENT.clear()
    code = gate_watch.main()
    got = [s[0] for s in SENT]
    ok = got == expect_sent and code == 0
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<46} sent={got} expected={expect_sent}")
    return ok


def main():
    tmp = Path(tempfile.gettempdir()) / "gate_watch_selftest_state.json"
    if tmp.exists():
        tmp.unlink()

    gate_watch.get_json = fake_get_json
    gate_watch.send = fake_send
    gate_watch.STATE_FILE = tmp
    sys.argv = ["gate_watch"]

    results = []
    results.append(run("all below the gate -> silence", []))

    FAKE["gold"] = 75
    results.append(run("GOLD crosses 70 -> ONE alert", ["GOLD"]))

    results.append(run("GOLD still above -> NO repeat", []))

    FAKE["gold"] = 80
    results.append(run("GOLD rises further -> still no repeat", []))

    FAKE["gold"] = 60
    results.append(run("GOLD falls below -> silence, and re-arms", []))

    FAKE["gold"] = 72
    results.append(run("GOLD crosses again -> alerts again", ["GOLD"]))

    # A failed send must NOT mark the asset armed, or the retry never happens and the
    # signal is lost silently - the exact failure this watcher exists to prevent.
    FAKE["spx"] = 90
    gate_watch.send = lambda *a: False
    run("SPX crosses but the send FAILS", [])
    state = json.loads(tmp.read_text(encoding="utf-8")) if tmp.exists() else {}
    not_armed = "SPX" not in state
    print(f"  {'PASS' if not_armed else 'FAIL'}  failed send leaves SPX unarmed for retry")
    results.append(not_armed)

    gate_watch.send = fake_send
    results.append(run("SPX retries on the next run -> alerts", ["SPX"]))

    # An unreadable gate must refuse rather than guess.
    gate_watch.get_json = lambda path, timeout=12: (
        {"confidenceThreshold": None} if path == "/api/strategy-settings" else fake_get_json(path))
    SENT.clear()
    code = gate_watch.main()
    refused = code == 2 and not SENT
    print(f"  {'PASS' if refused else 'FAIL'}  unreadable gate -> refuses, sends nothing (rc={code})")
    results.append(refused)

    if tmp.exists():
        tmp.unlink()
    failed = results.count(False)
    print(f"\n  {len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
