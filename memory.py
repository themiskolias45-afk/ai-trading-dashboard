"""
JARVIS Persistent Memory Engine
Stores and retrieves facts, decisions, lessons, and context across sessions.

Usage:
  python memory.py add "KEY_FINDING" "BTC 4H double bottom confirmed at 98k support"
  python memory.py recall trading
  python memory.py today
  python memory.py summary
  python memory.py forget "BTC 4H double bottom"
"""
import sys, os, json, time, re
from pathlib import Path
from datetime import datetime, timezone

MEMORY_FILE = Path(__file__).parent / "tasks" / "jarvis_memory.json"

CATEGORIES = {
    "TRADE":    "Trade setups, outcomes, lessons from specific trades",
    "SYSTEM":   "Server, config, infrastructure decisions",
    "MARKET":   "Market observations, regime changes, key levels",
    "CODE":     "Code decisions, bugs fixed, patterns used",
    "RISK":     "Risk management rules, sizing decisions",
    "LEARNING": "AI self-improvement, strategy tuning notes",
    "GENERAL":  "Anything that doesn't fit above",
}


class MemoryCorrupt(Exception):
    """The store exists but could not be read. Never treated as an empty store."""


def _load() -> dict:
    """ABSENT and CORRUPT are different answers and must never share a return value.

    This used to return an empty store for both. Every writer here calls _load,
    mutates the result and writes it back, so ONE unparseable read turned the whole
    file into a single row and exited 0. Combined with a truncate-then-write _save
    (which is what produces an unparseable file in the first place) that is a closed
    loop: the bad write creates the corruption, the silent read turns it into a
    delete, and the next add makes it permanent.

    server/index.js had the identical pair and was fixed on 2026-08-14; this file is
    the OTHER writer of the same tasks/jarvis_memory.json and CLAUDE.md lists
    `python memory.py add KEY VALUE` as a standing command, so it runs in every
    session. Fixing only the JavaScript side meant the server noticed the damage
    afterwards rather than the damage not happening.

    Absent is still a normal first run. Corrupt raises, because refusing to answer is
    the only response that cannot destroy 30-odd saved facts.
    """
    if not MEMORY_FILE.exists():
        MEMORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        return {"version": 1, "entries": [], "last_updated": None}
    try:
        raw = MEMORY_FILE.read_text(encoding="utf-8-sig")  # utf-8-sig strips a BOM
    except OSError as exc:
        raise MemoryCorrupt(
            f"{MEMORY_FILE} exists but could not be read: {exc}. Refusing to report an "
            f"empty store, because the next save would make that permanent."
        ) from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise MemoryCorrupt(
            f"{MEMORY_FILE} is not valid JSON ({exc}); {len(raw)} bytes on disk. NOT "
            f"returning an empty store: every writer round-trips through _load, so "
            f"doing so would delete every saved fact on the next add. Fix or move the "
            f"file by hand."
        ) from exc
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise MemoryCorrupt(
            f"{MEMORY_FILE} parsed but has no entries list — refusing to overwrite it."
        )
    return data


def _save(data: dict):
    """Atomic: write a temp file in the same directory, then os.replace.

    A plain write_text truncates the target first, so an interruption leaves exactly
    the half-written file _load now refuses to read. os.replace is atomic on Windows
    and POSIX alike, and same-directory keeps the rename intra-volume.
    """
    data["last_updated"] = datetime.now(timezone.utc).isoformat()
    MEMORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = MEMORY_FILE.with_suffix(MEMORY_FILE.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, MEMORY_FILE)


def add_memory(key: str, value: str, category: str = "GENERAL", source: str = "manual") -> dict:
    """Add or update a memory entry. Returns the entry."""
    data = _load()
    now = datetime.now(timezone.utc).isoformat()

    # Check if key already exists — update in place
    for entry in data["entries"]:
        if entry["key"].lower() == key.lower():
            entry["value"] = value
            entry["category"] = category.upper()
            entry["updated_at"] = now
            entry["source"] = source
            _save(data)
            return entry

    entry = {
        "key":        key,
        "value":      value,
        "category":   category.upper(),
        "source":     source,
        "created_at": now,
        "updated_at": now,
    }
    data["entries"].insert(0, entry)
    _save(data)
    return entry


def recall(query: str, limit: int = 10) -> list:
    """Search memory by keyword. Returns matching entries, newest first."""
    data = _load()
    q = query.lower()
    results = [
        e for e in data["entries"]
        if q in e["key"].lower() or q in e["value"].lower() or q in e.get("category", "").lower()
    ]
    return results[:limit]


def get_today(limit: int = 20) -> list:
    """Return entries created or updated today (UTC)."""
    data = _load()
    today = datetime.now(timezone.utc).date().isoformat()
    results = [
        e for e in data["entries"]
        if e.get("updated_at", "")[:10] == today or e.get("created_at", "")[:10] == today
    ]
    return results[:limit]


def forget(key: str) -> bool:
    """Remove a memory entry by key (partial match). Returns True if removed."""
    data = _load()
    before = len(data["entries"])
    data["entries"] = [e for e in data["entries"] if key.lower() not in e["key"].lower()]
    if len(data["entries"]) < before:
        _save(data)
        return True
    return False


def summary(limit: int = 5) -> dict:
    """Return a compact summary: total entries, by category, and most recent."""
    data = _load()
    entries = data["entries"]
    by_cat = {}
    for e in entries:
        cat = e.get("category", "GENERAL")
        by_cat[cat] = by_cat.get(cat, 0) + 1
    return {
        "total":       len(entries),
        "by_category": by_cat,
        "recent":      entries[:limit],
        "last_updated": data.get("last_updated"),
    }


def all_entries() -> list:
    return _load()["entries"]


def format_entries(entries: list) -> str:
    if not entries:
        return "  (no entries)"
    lines = []
    for e in entries:
        ts = e.get("updated_at", e.get("created_at", ""))[:10]
        lines.append(f"  [{e.get('category','?'):8s}] {ts}  {e['key']}")
        lines.append(f"           {e['value']}")
    return "\n".join(lines)


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return

    cmd = argv[0].lower()

    if cmd == "add":
        if len(argv) < 3:
            print("Usage: memory.py add KEY VALUE [CATEGORY]")
            sys.exit(1)
        key   = argv[1]
        value = argv[2]
        cat   = argv[3].upper() if len(argv) > 3 else "GENERAL"
        entry = add_memory(key, value, cat)
        print(f"[MEMORY] Stored: [{entry['category']}] {entry['key']}")

    elif cmd == "recall":
        query = argv[1] if len(argv) > 1 else ""
        if not query:
            print("Usage: memory.py recall KEYWORD")
            sys.exit(1)
        hits = recall(query)
        print(f"\n[MEMORY] Results for '{query}' ({len(hits)} found):")
        print(format_entries(hits))

    elif cmd == "today":
        hits = get_today()
        print(f"\n[MEMORY] Today's entries ({len(hits)}):")
        print(format_entries(hits))

    elif cmd == "summary":
        s = summary()
        print(f"\n[MEMORY] Total entries: {s['total']}")
        print("  By category:")
        for cat, count in sorted(s["by_category"].items()):
            print(f"    {cat:12s}: {count}")
        print(f"  Last updated: {s['last_updated'] or 'never'}")
        print("\n  Recent:")
        print(format_entries(s["recent"]))

    elif cmd == "forget":
        if len(argv) < 2:
            print("Usage: memory.py forget KEY")
            sys.exit(1)
        removed = forget(argv[1])
        if removed:
            print(f"[MEMORY] Removed entries matching '{argv[1]}'")
        else:
            print(f"[MEMORY] No entries matched '{argv[1]}'")

    elif cmd == "all":
        entries = all_entries()
        print(f"\n[MEMORY] All entries ({len(entries)}):")
        print(format_entries(entries))

    else:
        print(f"[MEMORY] Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    # A corrupt store must fail loudly and non-zero, never quietly "succeed" having
    # written a one-row file. Caught here so the operator gets the diagnosis and the
    # remedy instead of a traceback, and so any .bat calling this sees a real failure.
    try:
        main()
    except MemoryCorrupt as exc:
        print(f"[MEMORY] REFUSING TO WRITE — {exc}", file=sys.stderr)
        print("[MEMORY] Nothing was modified. Inspect or move the file, then retry.",
              file=sys.stderr)
        sys.exit(2)
