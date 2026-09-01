"""
RAG Index — embed trades, lessons, vault notes, and strategy research into
a local ChromaDB vector store for semantic search.

  python tasks/rag_index.py [--rebuild] [--source all|trades|lessons|memory|brain|vault|shadow]

Requirements:
  pip install chromadb sentence-transformers

WHAT IT INDEXES
  trades      — every entry in /api/journal (outcome, setup, symbol, entry, note)
  lessons     — all entities in server/learning_shadow.json shadow stats
  memory      — tasks/jarvis_memory.json entries (session notes, plans, EOD)
  brain       — the Claude Code memory corpus, one fact per .md, DISCOVERED
                at ~/.claude/projects/<slug>/memory (the slug differs per box)
  vault       — markdown files from the vault path (C:/Users/User/Documents/Brain)
  shadow      — setup-level findings from server/learning_shadow.json

WHAT IT DOES NOT DO
  - Never writes learning.json, journal.json, or smartentry.db
  - Never changes signals, gates, thresholds, or settings
  - ChromaDB is a local read/write store in tasks/rag_db/ — nothing leaves the machine

USAGE
  Index everything:         python tasks/rag_index.py
  Rebuild from scratch:     python tasks/rag_index.py --rebuild
  Index only trades:        python tasks/rag_index.py --source trades
  Query (see rag_query.py): python tasks/rag_query.py "has Gold rejected at 2400 before?"
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT   = Path(__file__).parent.parent
DB_DIR = ROOT / "tasks" / "rag_db"

try:
    import chromadb
    from chromadb.config import Settings
    from sentence_transformers import SentenceTransformer
    DEPS_OK = True
except ImportError:
    DEPS_OK = False


MODEL_NAME  = "all-MiniLM-L6-v2"   # 22MB, fast, runs locally
SERVER_URL  = "http://localhost:3001"


def _require_deps():
    if not DEPS_OK:
        print("ERROR: Missing dependencies. Run:")
        print("  pip install chromadb sentence-transformers")
        sys.exit(1)


def _fetch(path: str):
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as exc:
        return {"_error": str(exc)}


def _get_client():
    DB_DIR.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(path=str(DB_DIR))


def _get_collection(client, name: str):
    return client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"},
    )


def _embed(model, texts: list[str]) -> list:
    return model.encode(texts, show_progress_bar=False).tolist()


def _existing_ids(collection, rebuild: bool) -> set:
    """Ids already in the collection — and a LOUD warning when there are none.

    A REBUILD IS NOT ATOMIC. `--rebuild` calls delete_collection() and only then
    re-adds, so a run killed in that window leaves the collection EMPTY. That happened
    on 2026-09-01: a reindex was killed by a 2-minute timeout (exit 143), and the next
    ordinary run re-added all 1716 chunks and reported "1716 new | 1716 total" — which
    is indistinguishable, in the output, from a healthy incremental run. The index was
    briefly empty and nothing said so.

    An empty index is the worst possible silent state here: every query returns
    "no relevant results", which reads as "the system never recorded that" rather than
    "the index is gone". Same shape as the near-miss census dying at every restart.

    So: on a NON-rebuild run, an empty collection means a previous run did not finish.
    Say it, rather than quietly refilling and printing a total that looks fine.
    """
    ids = set(collection.get(include=[])["ids"])
    if not ids and not rebuild:
        print(f"  [{collection.name}] WARNING: collection is EMPTY on a non-rebuild run. "
              f"A previous --rebuild was interrupted (delete_collection succeeded, the "
              f"re-add did not). Everything below is a full re-add, not an increment.")
    return ids


# ── Source: trades ────────────────────────────────────────────────────────────

def index_trades(client, model, rebuild: bool = False):
    collection = _get_collection(client, "trades")
    if rebuild:
        client.delete_collection("trades")
        collection = _get_collection(client, "trades")

    raw = _fetch("/api/journal?limit=1000")
    if "_error" in raw:
        print("  [trades] Server offline or no journal — skipping.")
        return 0
    journal = raw.get("journal", raw) if isinstance(raw, dict) else raw
    if not isinstance(journal, list):
        print("  [trades] Unexpected journal format — skipping.")
        return 0

    existing_ids = _existing_ids(collection, rebuild)
    new_docs, new_ids, new_metas = [], [], []

    for trade in journal:
        tid = str(trade.get("id") or trade.get("ticket") or "")
        if not tid or tid in existing_ids:
            continue

        symbol    = trade.get("symbol", "")
        setup     = trade.get("setup", "")
        direction = trade.get("direction", trade.get("signal", ""))
        outcome   = trade.get("outcome", "")
        entry     = trade.get("entry", "")
        stop      = trade.get("stop", "")
        note      = trade.get("note", "") or ""
        opened_at = trade.get("openedAt", trade.get("date", ""))

        text = (
            f"{symbol} {direction} {setup} trade opened {opened_at}. "
            f"Entry {entry} Stop {stop}. Outcome: {outcome}. {note}"
        ).strip()

        new_docs.append(text)
        new_ids.append(f"trade_{tid}")
        new_metas.append({
            "source": "journal", "symbol": symbol, "setup": setup,
            "outcome": outcome, "direction": direction, "date": str(opened_at),
        })

    if new_docs:
        embeddings = _embed(model, new_docs)
        collection.add(documents=new_docs, embeddings=embeddings,
                       ids=new_ids, metadatas=new_metas)

    total = collection.count()
    print(f"  [trades] {len(new_docs)} new | {total} total in index")
    return len(new_docs)


# ── Source: shadow stats (setup-level lessons) ────────────────────────────────

def index_shadow(client, model, rebuild: bool = False):
    collection = _get_collection(client, "lessons")
    if rebuild:
        client.delete_collection("lessons")
        collection = _get_collection(client, "lessons")

    shadow_path = ROOT / "server" / "learning_shadow.json"
    try:
        raw = json.loads(shadow_path.read_text(encoding="utf-8"))
        shadow = raw.get("shadowStats", {})
    except Exception:
        print("  [shadow] learning_shadow.json not found — run learning_from_rejections.py first.")
        return 0

    existing_ids = _existing_ids(collection, rebuild)
    new_docs, new_ids, new_metas = [], [], []

    for setup, stats in shadow.items():
        sid = f"shadow_{setup}"
        if sid in existing_ids:
            continue

        wr      = stats.get("winRate", 0)
        eps     = stats.get("episodes", 0)
        total_r = stats.get("totalR", 0)
        gates   = ", ".join(stats.get("gates", []))
        symbols = ", ".join(stats.get("symbols", []))
        usable  = "USABLE" if stats.get("enoughForReading") else "insufficient"

        text = (
            f"Setup {setup}: {eps} paper episodes, {wr}% win rate, {total_r:+.2f}R total. "
            f"Gates: {gates}. Symbols: {symbols}. Evidence quality: {usable}."
        )

        new_docs.append(text)
        new_ids.append(sid)
        new_metas.append({
            "source": "shadow", "setup": setup, "win_rate": wr,
            "episodes": eps, "usable": usable,
        })

    if new_docs:
        embeddings = _embed(model, new_docs)
        collection.add(documents=new_docs, embeddings=embeddings,
                       ids=new_ids, metadatas=new_metas)

    total = collection.count()
    print(f"  [shadow] {len(new_docs)} new | {total} total in index")
    return len(new_docs)


# ── Source: jarvis_memory.json ────────────────────────────────────────────────

def index_memory(client, model, rebuild: bool = False):
    collection = _get_collection(client, "memory")
    if rebuild:
        client.delete_collection("memory")
        collection = _get_collection(client, "memory")

    mem_path = ROOT / "tasks" / "jarvis_memory.json"
    try:
        raw = json.loads(mem_path.read_text(encoding="utf-8"))
    except Exception:
        print("  [memory] jarvis_memory.json not found — skipping.")
        return 0

    # THE FILE IS {"version", "entries", "last_updated"} — NOT a bare list.
    # This used to do `list(raw.values())` on that wrapper, which hands the loop
    # [1, [...93 entries...], "2026-..."]: the int is skipped, the LIST is skipped
    # (it is neither str nor dict), and the last_updated STRING is indexed as a
    # memory. Measured 2026-09-01: the collection held exactly ONE document and it
    # was a bare timestamp. The source has never worked, and it reported success
    # every run — a count of 1 looks like a nearly-empty index, not a bug.
    if isinstance(raw, dict):
        entries = raw.get("entries")
        if not isinstance(entries, list):
            # Some older dumps really were {key: value}; keep them working, but only
            # after the documented shape has been ruled out.
            entries = [v for v in raw.values() if isinstance(v, (str, dict))]
    elif isinstance(raw, list):
        entries = raw
    else:
        print(f"  [memory] unexpected top-level type {type(raw).__name__} — skipping.")
        return 0

    existing_ids = _existing_ids(collection, rebuild)
    new_docs, new_ids, new_metas = [], [], []

    for i, entry in enumerate(entries[-500:]):   # last 500
        if isinstance(entry, str):
            text = entry
            key  = f"mem_{i}"
            tag  = "general"
        elif isinstance(entry, dict):
            text = entry.get("value") or entry.get("text") or str(entry)
            key  = entry.get("key") or f"mem_{i}"
            tag  = entry.get("tag") or entry.get("category") or "general"
        else:
            continue

        mid = f"memory_{key}"
        if mid in existing_ids or not text.strip():
            continue

        new_docs.append(text[:1000])
        new_ids.append(mid)
        new_metas.append({"source": "memory", "key": str(key), "tag": str(tag)})

    if new_docs:
        embeddings = _embed(model, new_docs)
        collection.add(documents=new_docs, embeddings=embeddings,
                       ids=new_ids, metadatas=new_metas)

    total = collection.count()
    print(f"  [memory] {len(new_docs)} new | {total} total in index")
    return len(new_docs)


# ── Source: brain — the Claude Code memory corpus ─────────────────────────────
#
# WHY THIS EXISTS. The corpus is 312 one-fact markdown files behind a single
# hand-written index, MEMORY.md, which the session loader truncates by BYTES.
# Measured 2026-09-01: 29,626B against a 24,576B limit, so 32 of 166 index lines
# — 17%, the whole "AI Employee, agents and scripts" section — never reach a
# booting session. The facts are all on disk; the pointer to them is not. Growing
# the corpus makes that strictly worse, which is why more memories were not the
# answer and retrieval was.
#
# READ-ONLY over the corpus. This opens .md files and writes only to tasks/rag_db/.

def _find_brain_corpus() -> Path | None:
    """Locate the Claude Code memory dir. DISCOVERED, never hardcoded.

    The two boxes disagree on every component of this path — the laptop is
    ~/.claude/projects/C--Users-User-ai-trading-dashboard/memory and the VPS is
    ~/.claude/projects/C--ai-trading-dashboard/memory, because the slug is derived
    from the repo's own location. A hardcoded path silently indexes nothing on one
    of them, and an index that is empty for the right-looking reason is the failure
    mode this whole file exists to fix.
    """
    override = os.environ.get("JARVIS_BRAIN_PATH")
    if override and Path(override).is_dir():
        return Path(override)

    projects = Path.home() / ".claude" / "projects"
    if not projects.is_dir():
        return None

    # Prefer the project dir whose slug matches THIS repo; fall back to whichever
    # memory dir holds the most files, so a renamed repo still finds its own brain.
    slug_hint = str(ROOT).replace(":", "-").replace(os.sep, "-").replace("/", "-")
    candidates = []
    for proj in projects.iterdir():
        mem = proj / "memory"
        if not mem.is_dir():
            continue
        count = len(list(mem.glob("*.md")))
        if count == 0:
            continue
        candidates.append((proj.name == slug_hint, count, mem))
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0], c[1]), reverse=True)
    return candidates[0][2]


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Pull name/description/type out of the --- block. Returns (meta, body).

    Deliberately not a YAML parse: the frontmatter here is a fixed three-field
    shape, and adding a yaml dependency to read it would be the larger change.
    A file with no frontmatter is normal and returns ({}, whole text).
    """
    meta = {}
    if not text.startswith("---"):
        return meta, text
    end = text.find("\n---", 3)
    if end == -1:
        return meta, text
    block, body = text[3:end], text[end + 4:]
    current = None
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not line.startswith((" ", "\t")) and ":" in stripped:
            key, _, val = stripped.partition(":")
            current = key.strip()
            meta[current] = val.strip().strip('"').strip("'")
        elif current == "metadata" and ":" in stripped:
            key, _, val = stripped.partition(":")
            meta[f"metadata.{key.strip()}"] = val.strip().strip('"').strip("'")
    return meta, body


def index_brain(client, model, rebuild: bool = False):
    # THE DELETE IS DEFERRED, deliberately. It used to happen HERE, before the corpus
    # was read and before ~1700 chunks were embedded — so a --rebuild left the index
    # empty for the entire duration of the slow part, and a kill anywhere in there
    # (a 2-minute tool timeout did exactly this on 2026-09-01) destroyed the index and
    # left no trace but an unusually large "new" count on the next run.
    #
    # Now the expensive work happens against the LIVE index and the delete fires
    # immediately before the add, shrinking the window from minutes to milliseconds.
    # Not a transaction — chromadb has none — but the difference between "empty while
    # a model loads and 1700 embeddings compute" and "empty for one call" is the
    # difference between a likely failure and an unlikely one.
    collection = _get_collection(client, "brain")

    corpus = _find_brain_corpus()
    if corpus is None:
        print("  [brain] no Claude Code memory dir found — skipping. "
              "Set JARVIS_BRAIN_PATH to override.")
        return 0

    # On a rebuild nothing counts as already-present, so every chunk is rebuilt —
    # but the collection is not emptied until the add below.
    existing_ids = set() if rebuild else _existing_ids(collection, rebuild)
    new_docs, new_ids, new_metas = [], [], []
    files = skipped = 0

    for md in sorted(corpus.glob("*.md")):
        try:
            text = md.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            print(f"  [brain] unreadable, skipped: {md.name} ({exc})")
            skipped += 1
            continue
        if len(text.strip()) < 40:
            skipped += 1
            continue
        files += 1

        fm, body = _parse_frontmatter(text)
        name  = fm.get("name") or md.stem
        desc  = fm.get("description") or ""
        mtype = fm.get("metadata.type") or ("index" if md.name == "MEMORY.md" else "unknown")

        # The description is the recall surface the memory system itself was
        # designed around, so it leads every chunk. Without it a chunk from the
        # middle of a file arrives with no idea what claim it belongs to.
        header = f"{name}: {desc}".strip().rstrip(":")
        base   = f"brain_{md.stem}"

        step, size = 700, 800
        chunks = [body[i:i + size].strip() for i in range(0, max(len(body), 1), step)]
        chunks = [c for c in chunks if c]
        for ci, chunk in enumerate(chunks):
            cid = f"{base}_c{ci}"
            if cid in existing_ids:
                continue
            new_docs.append(f"{header}\n\n{chunk}" if header else chunk)
            new_ids.append(cid)
            new_metas.append({
                "source": "brain", "file": md.name, "name": str(name),
                "description": str(desc)[:300], "type": str(mtype), "chunk": ci,
            })

    if new_docs:
        batch = 64
        embeds = []
        for i in range(0, len(new_docs), batch):
            embeds.extend(_embed(model, new_docs[i:i + batch]))
        # The embeddings are computed and in hand. NOW swap, so the index is empty
        # for one call rather than for the whole run.
        if rebuild:
            client.delete_collection("brain")
            collection = _get_collection(client, "brain")
        collection.add(documents=new_docs, embeddings=embeds,
                       ids=new_ids, metadatas=new_metas)

    total = collection.count()
    print(f"  [brain] {corpus}")
    print(f"  [brain] {files} file(s) read, {skipped} skipped | "
          f"{len(new_docs)} new chunk(s) | {total} total in index")
    return len(new_docs)


# ── Source: vault markdown notes ──────────────────────────────────────────────

def index_vault(client, model, rebuild: bool = False):
    collection = _get_collection(client, "vault")
    if rebuild:
        client.delete_collection("vault")
        collection = _get_collection(client, "vault")

    # HOME-RELATIVE FIRST. This listed C:/Users/User/Documents/Brain — the LAPTOP's
    # path — as candidate one, so on the VPS it did not exist, the list fell through to
    # ROOT/"vault-setup", and the vault collection was silently built from the WRONG
    # DIRECTORY: 17 chunks there against 260 here, from the same 22-file vault. The
    # collection was populated and the run reported success, which is why it went
    # unnoticed. Exactly the failure _find_brain_corpus was written to avoid; this
    # function was simply never given the same treatment.
    vault_candidates = [
        Path(os.environ.get("JARVIS_VAULT_PATH", "nonexistent")),
        Path.home() / "Documents" / "Brain",
        Path("C:/Users/User/Documents/Brain"),
        ROOT / "vault-setup",
    ]
    vault_root = next((p for p in vault_candidates if p.exists()), None)
    if not vault_root:
        print("  [vault] Vault path not found — skipping. Set JARVIS_VAULT_PATH env var.")
        return 0

    existing_ids = _existing_ids(collection, rebuild)
    new_docs, new_ids, new_metas = [], [], []

    for md_file in vault_root.rglob("*.md"):
        try:
            text = md_file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        if len(text.strip()) < 50:
            continue

        rel    = str(md_file.relative_to(vault_root))
        vid    = f"vault_{rel.replace(os.sep, '_').replace(' ', '_')}"
        if vid in existing_ids:
            continue

        # Chunk long notes at 800 chars with 100-char overlap
        chunks = []
        step   = 700
        for start in range(0, len(text), step):
            chunk = text[start:start + 800].strip()
            if chunk:
                chunks.append(chunk)

        for ci, chunk in enumerate(chunks):
            cid = f"{vid}_c{ci}"
            if cid in existing_ids:
                continue
            new_docs.append(chunk)
            new_ids.append(cid)
            new_metas.append({
                "source": "vault", "file": rel, "chunk": ci,
            })

    if new_docs:
        # Batch embed to avoid memory issues on large vaults
        batch = 64
        all_embeds = []
        for i in range(0, len(new_docs), batch):
            all_embeds.extend(_embed(model, new_docs[i:i + batch]))
        collection.add(documents=new_docs, embeddings=all_embeds,
                       ids=new_ids, metadatas=new_metas)

    total = collection.count()
    print(f"  [vault] {len(new_docs)} new chunks | {total} total in index")
    return len(new_docs)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    _require_deps()

    argv    = sys.argv[1:]
    rebuild = "--rebuild" in argv
    source  = "all"
    for i, a in enumerate(argv):
        if a == "--source" and i + 1 < len(argv):
            source = argv[i + 1]

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"\n[{ts}] RAG Indexer — model: {MODEL_NAME} | source: {source} | rebuild: {rebuild}")
    print(f"DB: {DB_DIR}\n")

    model  = SentenceTransformer(MODEL_NAME)
    client = _get_client()

    total = 0
    if source in ("all", "trades"):
        total += index_trades(client, model, rebuild)
    if source in ("all", "shadow", "lessons"):
        total += index_shadow(client, model, rebuild)
    if source in ("all", "memory"):
        total += index_memory(client, model, rebuild)
    if source in ("all", "brain"):
        total += index_brain(client, model, rebuild)
    if source in ("all", "vault"):
        total += index_vault(client, model, rebuild)

    print(f"\nDone. {total} new document(s) indexed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
