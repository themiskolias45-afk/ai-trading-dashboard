"""
RAG Index — embed trades, lessons, vault notes, and strategy research into
a local ChromaDB vector store for semantic search.

  python tasks/rag_index.py [--rebuild] [--source all|trades|lessons|vault|shadow]

Requirements:
  pip install chromadb sentence-transformers

WHAT IT INDEXES
  trades      — every entry in /api/journal (outcome, setup, symbol, entry, note)
  lessons     — all entities in server/learning_shadow.json shadow stats
  memory      — reads tasks/jarvis_memory.json last 100 entries
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

    existing_ids = set(collection.get(include=[])["ids"])
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

    existing_ids = set(collection.get(include=[])["ids"])
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
        entries = json.loads(mem_path.read_text(encoding="utf-8"))
        if not isinstance(entries, list):
            entries = list(entries.values()) if isinstance(entries, dict) else []
    except Exception:
        print("  [memory] jarvis_memory.json not found — skipping.")
        return 0

    existing_ids = set(collection.get(include=[])["ids"])
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


# ── Source: vault markdown notes ──────────────────────────────────────────────

def index_vault(client, model, rebuild: bool = False):
    collection = _get_collection(client, "vault")
    if rebuild:
        client.delete_collection("vault")
        collection = _get_collection(client, "vault")

    vault_candidates = [
        Path("C:/Users/User/Documents/Brain"),
        Path(os.environ.get("JARVIS_VAULT_PATH", "nonexistent")),
        ROOT / "vault-setup",
    ]
    vault_root = next((p for p in vault_candidates if p.exists()), None)
    if not vault_root:
        print("  [vault] Vault path not found — skipping. Set JARVIS_VAULT_PATH env var.")
        return 0

    existing_ids = set(collection.get(include=[])["ids"])
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
    if source in ("all", "vault"):
        total += index_vault(client, model, rebuild)

    print(f"\nDone. {total} new document(s) indexed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
