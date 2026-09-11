#!/usr/bin/env python
"""
memory_index_guard.py - keep the memory corpus FINDABLE, and prove nothing was lost.

WHY THIS EXISTS
  The 414 memory files are the memory. The chroma index over them is DERIVED - destroy
  it and `rag_index.py --source brain` rebuilds it from the same files, so an index
  failure can never be a memory loss. What an index failure CAN do is make a memory
  invisible, which reads exactly like "the system never recorded that".

  Measured 2026-09-11: `brain` is reindexed once a day by tasks/brain_sync.cjs (04:10).
  A memory written at 18:00 was therefore not retrievable for ten hours, and four
  memories - two written that afternoon - were missing from the index when checked.
  CLAUDE.md says "Rebuild after writing a memory: python tasks/rag_index.py --source
  brain", which is a rule enforced by remembering, and this repo's own doctrine is that
  such a rule is decoration. This is its enforcer.

IT NEVER REBUILDS. `--rebuild` calls delete_collection() and only then re-adds, so a run
  killed in that window leaves the collection EMPTY - which happened on 2026-09-01, and
  the next ordinary run reported "1716 new | 1716 total", indistinguishable in the output
  from a healthy incremental run. rag_index.py's own _existing_ids() documents it. So
  this only ever runs INCREMENTAL, which adds and never deletes. A rebuild stays a
  deliberate human act.

IT PROVES THE INDEX DID NOT SHRINK. Chunk count is read before and after. Incremental
  indexing can only add, so a DROP means something destroyed data and is reported
  loudly with the remedy. That is the check the 2026-09-01 incident did not have.

IT SKIPS FAST WHEN THERE IS NOTHING TO DO. It compares the newest memory file's mtime
  against a stamp of the last successful run and exits in milliseconds if nothing has
  changed - so it can sit on a session-stop hook without adding a model load to every
  session that wrote no memory.

IT CANNOT BLOCK ANYTHING. It reads .md files and writes a chroma index and its own log.
  No gate, threshold, setup, confidence, size, stop, order path, journal or learning
  record is reachable from here.

  python tasks/memory_index_guard.py           index if anything changed
  python tasks/memory_index_guard.py --force   index regardless
  python tasks/memory_index_guard.py --check   report only, index nothing
"""

import os
import sys
import json
import sqlite3
import subprocess
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "tasks", "rag_db", "chroma.sqlite3")
STAMP = os.path.join(ROOT, "tasks", "logs", ".memory_index_stamp.json")
LOG = os.path.join(ROOT, "tasks", "logs", "memory_index.txt")
INDEXER = os.path.join(ROOT, "tasks", "rag_index.py")

# The indexer loads a sentence-transformers model; a cold run is tens of seconds. Well
# above that, and far below anything that would strand a session-stop hook.
INDEX_TIMEOUT_SEC = 600


def memory_dir():
    """The brain corpus, discovered the same way rag_index.py finds it."""
    base = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    if not os.path.isdir(base):
        return None
    best, best_n = None, 0
    for name in os.listdir(base):
        mem = os.path.join(base, name, "memory")
        if not os.path.isdir(mem):
            continue
        n = len([f for f in os.listdir(mem) if f.endswith(".md")])
        if n > best_n:
            best, best_n = mem, n
    return best


def say(msg):
    line = "[%s] %s" % (datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), msg)
    print(line)
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass  # the log is a convenience, never a blocker


def chunk_count():
    """Chunks in the brain collection. None if the DB cannot be read."""
    if not os.path.exists(DB):
        return None
    try:
        con = sqlite3.connect("file:%s?mode=ro" % DB.replace("\\", "/"), uri=True)
        try:
            row = con.execute(
                "select count(*) from embeddings e "
                "join segments s on s.id = e.segment_id "
                "join collections c on c.id = s.collection "
                "where c.name = 'brain'"
            ).fetchone()
            return int(row[0]) if row else None
        finally:
            con.close()
    except Exception:
        return None


def newest_memory_mtime(mem):
    newest = 0.0
    for f in os.listdir(mem):
        if not f.endswith(".md"):
            continue
        try:
            newest = max(newest, os.path.getmtime(os.path.join(mem, f)))
        except OSError:
            continue
    return newest


def read_stamp():
    try:
        with open(STAMP, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def write_stamp(data):
    try:
        tmp = STAMP + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, STAMP)      # atomic; a reader never sees it half-written
    except Exception as exc:
        say("  NOTE: could not write the stamp (%s) - the next run will simply re-index" % exc)


def main(argv):
    force = "--force" in argv
    check_only = "--check" in argv

    mem = memory_dir()
    if not mem:
        say("memory corpus not found under ~/.claude/projects - nothing to index")
        return 0

    files = [f for f in os.listdir(mem) if f.endswith(".md")]
    newest = newest_memory_mtime(mem)
    stamp = read_stamp()
    last = float(stamp.get("indexedUpToMtime") or 0)
    before = chunk_count()

    if check_only:
        say("CHECK: %d memory files | %s chunks in 'brain' | newest file %s | stamp %s"
            % (len(files),
               "unreadable" if before is None else before,
               datetime.datetime.fromtimestamp(newest).isoformat(timespec="seconds"),
               datetime.datetime.fromtimestamp(last).isoformat(timespec="seconds") if last else "never"))
        return 0

    if not force and last and newest <= last:
        # Nothing written since the last successful index. Milliseconds, no model load.
        return 0

    say("indexing: %d memory files, newest %s (last indexed %s)"
        % (len(files),
           datetime.datetime.fromtimestamp(newest).isoformat(timespec="seconds"),
           datetime.datetime.fromtimestamp(last).isoformat(timespec="seconds") if last else "never"))

    # INCREMENTAL ONLY. --rebuild is never passed from here; see the header.
    try:
        proc = subprocess.run(
            [sys.executable, INDEXER, "--source", "brain"],
            cwd=ROOT, capture_output=True, text=True, timeout=INDEX_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        say("  FAILED: the indexer exceeded %ds and was stopped. Nothing was deleted - "
            "incremental indexing only ever adds. Re-run by hand: "
            "python tasks/rag_index.py --source brain" % INDEX_TIMEOUT_SEC)
        return 1
    except Exception as exc:
        say("  FAILED to start the indexer: %s" % exc)
        return 1

    tail = [l for l in (proc.stdout or "").splitlines() if l.strip()][-2:]
    for line in tail:
        say("  " + line.strip())

    after = chunk_count()

    # THE NO-LOSS CHECK. Incremental indexing can only ADD, so a drop means something
    # destroyed data - the silent failure the 2026-09-01 incident had no detector for.
    if before is not None and after is not None and after < before:
        say("  *** INDEX SHRANK: %d -> %d chunks. Incremental indexing cannot remove "
            "anything, so something else did. The MEMORY FILES ARE NOT AFFECTED - they "
            "are the memory and this index is derived from them. Rebuild deliberately "
            "with: python tasks/rag_index.py --source brain --rebuild ***" % (before, after))
        return 1

    if proc.returncode != 0:
        say("  indexer exited %d - reported, not swallowed. Chunks %s -> %s"
            % (proc.returncode, before, after))
        return 1

    say("  ok: chunks %s -> %s across %d files" % (before, after, len(files)))
    write_stamp({
        "indexedUpToMtime": newest,
        "indexedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "files": len(files),
        "chunksBefore": before,
        "chunksAfter": after,
        "source": "tasks/memory_index_guard.py",
    })
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
