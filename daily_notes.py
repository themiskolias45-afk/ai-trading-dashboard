"""
JARVIS Daily Notes Engine
Auto-logs trading sessions, signals, outcomes, and insights per day.

Usage:
  python daily_notes.py log "BTC LONG signal fired at 105k, confidence 87%"
  python daily_notes.py today
  python daily_notes.py yesterday
  python daily_notes.py date 2026-07-22
  python daily_notes.py summary
  python daily_notes.py auto       # auto-pull from server and log today's signals/trades
"""
import sys, json, time
from pathlib import Path
from datetime import datetime, timezone, timedelta

NOTES_DIR = Path(__file__).parent / "tasks" / "daily"
SERVER_URL = "http://localhost:3001"


def _today_str() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _note_path(date_str: str) -> Path:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    return NOTES_DIR / f"{date_str}.json"


def _load_note(date_str: str) -> dict:
    path = _note_path(date_str)
    if not path.exists():
        return {
            "date":      date_str,
            "entries":   [],
            "signals":   [],
            "trades":    [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"date": date_str, "entries": [], "signals": [], "trades": []}


def _save_note(note: dict):
    date_str = note["date"]
    path = _note_path(date_str)
    note["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(note, indent=2, ensure_ascii=False), encoding="utf-8")


def log_entry(text: str, tag: str = "NOTE", date_str: str = None) -> dict:
    """Append a freeform log entry to today's (or specified date's) note."""
    date_str = date_str or _today_str()
    note = _load_note(date_str)
    entry = {
        "ts":  datetime.now(timezone.utc).isoformat(),
        "tag": tag.upper(),
        "text": text,
    }
    note["entries"].append(entry)
    _save_note(note)
    return entry


def get_note(date_str: str) -> dict:
    return _load_note(date_str)


def _fetch_json(path: str):
    import urllib.request
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=4) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


def auto_log() -> dict:
    """Pull signals and trades from server and append them to today's note."""
    date_str = _today_str()
    note = _load_note(date_str)

    signals = _fetch_json("/api/signals")
    if signals:
        if isinstance(signals, list):
            note["signals"] = signals
        else:
            note["signals"] = [signals]
        note["entries"].append({
            "ts":  datetime.now(timezone.utc).isoformat(),
            "tag": "AUTO",
            "text": f"Pulled {len(note['signals'])} signal(s) from server",
        })

    trades = _fetch_json("/api/journal")
    if trades and isinstance(trades, list):
        today_trades = [t for t in trades if (t.get("opened_at") or "")[:10] == date_str]
        note["trades"] = today_trades
        note["entries"].append({
            "ts":  datetime.now(timezone.utc).isoformat(),
            "tag": "AUTO",
            "text": f"Pulled {len(today_trades)} trade(s) for today",
        })

    healer = _fetch_json("/api/healer")
    if healer:
        status = "HEALTHY" if healer.get("healthy") else "DEGRADED"
        note["entries"].append({
            "ts":  datetime.now(timezone.utc).isoformat(),
            "tag": "HEALER",
            "text": f"System status: {status} | checks: {healer.get('checks', [])}",
        })

    _save_note(note)
    return note


def list_dates(limit: int = 7) -> list:
    """Return list of note dates available, newest first."""
    if not NOTES_DIR.exists():
        return []
    files = sorted(NOTES_DIR.glob("*.json"), reverse=True)
    return [f.stem for f in files[:limit]]


def format_note(note: dict) -> str:
    lines = [
        "",
        f"=== DAILY NOTE: {note['date']} ===",
    ]

    if note.get("signals"):
        lines.append(f"\nSIGNALS ({len(note['signals'])}):")
        for s in note["signals"]:
            lines.append(
                f"  {s.get('symbol','?')} {s.get('direction','?')} "
                f"@ {s.get('entry','?')} conf={s.get('confidence','?')}%"
            )

    if note.get("trades"):
        lines.append(f"\nTRADES ({len(note['trades'])}):")
        for t in note["trades"]:
            pnl = t.get("pnl")
            pnl_str = f"PnL={pnl:+.2f}" if pnl is not None else "open"
            lines.append(
                f"  {t.get('symbol','?')} {t.get('direction','?')} {pnl_str}"
            )

    entries = note.get("entries", [])
    if entries:
        lines.append(f"\nLOG ({len(entries)} entries):")
        for e in entries:
            ts = e.get("ts", "")[:16].replace("T", " ")
            lines.append(f"  {ts}  [{e.get('tag','?'):7s}] {e.get('text','')}")

    if not note.get("signals") and not note.get("trades") and not entries:
        lines.append("  (empty)")

    lines.append("")
    return "\n".join(lines)


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return

    cmd = argv[0].lower()

    if cmd == "log":
        if len(argv) < 2:
            print("Usage: daily_notes.py log TEXT [TAG]")
            sys.exit(1)
        text = argv[1]
        tag  = argv[2] if len(argv) > 2 else "NOTE"
        entry = log_entry(text, tag)
        print(f"[DAILY] Logged [{entry['tag']}]: {entry['text']}")

    elif cmd == "today":
        note = get_note(_today_str())
        print(format_note(note))

    elif cmd == "yesterday":
        yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
        note = get_note(yesterday)
        print(format_note(note))

    elif cmd == "date":
        if len(argv) < 2:
            print("Usage: daily_notes.py date YYYY-MM-DD")
            sys.exit(1)
        note = get_note(argv[1])
        print(format_note(note))

    elif cmd == "summary":
        dates = list_dates(7)
        if not dates:
            print("[DAILY] No notes found.")
            return
        print(f"\n[DAILY] Notes for last {len(dates)} days:")
        for d in dates:
            note = get_note(d)
            n_entries  = len(note.get("entries", []))
            n_signals  = len(note.get("signals", []))
            n_trades   = len(note.get("trades", []))
            print(f"  {d}  signals={n_signals}  trades={n_trades}  log={n_entries}")

    elif cmd == "auto":
        note = auto_log()
        print(f"[DAILY] Auto-logged to {note['date']}")
        print(format_note(note))

    else:
        print(f"[DAILY] Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
