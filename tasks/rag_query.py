"""
RAG Query — semantic search over the indexed trading knowledge base.

  python tasks/rag_query.py "has Gold rejected at 2400 before?"
  python tasks/rag_query.py "what setups work best in trending markets?" --top 5
  python tasks/rag_query.py "RANGE_TRADE_LONG performance" --source trades
  python tasks/rag_query.py "what did JARVIS learn about RSI ceiling?" --source memory,vault

Usage from Python:
  from tasks.rag_query import query
  results = query("has Gold done this before?", top_k=5)

Requirements:
  pip install chromadb sentence-transformers

Run rag_index.py first to build the index.
"""

import json
import sys
from pathlib import Path

ROOT   = Path(__file__).parent.parent
DB_DIR = ROOT / "tasks" / "rag_db"

try:
    import chromadb
    from sentence_transformers import SentenceTransformer
    DEPS_OK = True
except ImportError:
    DEPS_OK = False

MODEL_NAME = "all-MiniLM-L6-v2"
_model_cache = None


def _get_model():
    global _model_cache
    if _model_cache is None:
        _model_cache = SentenceTransformer(MODEL_NAME)
    return _model_cache


def _get_client():
    if not DB_DIR.exists():
        return None
    return chromadb.PersistentClient(path=str(DB_DIR))


def query(question: str, top_k: int = 5, sources: list[str] | None = None) -> list[dict]:
    """
    Semantic search over indexed knowledge.

    Returns list of dicts: {text, score, source, metadata}
    Empty list if index does not exist or no results.
    """
    if not DEPS_OK:
        return [{"error": "chromadb/sentence-transformers not installed. Run: pip install chromadb sentence-transformers"}]

    client = _get_client()
    if client is None:
        return [{"error": "RAG index not found. Run: python tasks/rag_index.py"}]

    model     = _get_model()
    embedding = model.encode([question]).tolist()[0]

    all_sources = sources or ["trades", "lessons", "memory", "vault"]
    results     = []

    for src in all_sources:
        try:
            col = client.get_collection(src)
        except Exception:
            continue

        res = col.query(
            query_embeddings=[embedding],
            n_results=min(top_k, col.count()),
            include=["documents", "metadatas", "distances"],
        )

        docs      = res.get("documents", [[]])[0]
        metas     = res.get("metadatas", [[]])[0]
        distances = res.get("distances", [[]])[0]

        for doc, meta, dist in zip(docs, metas, distances):
            score = round(1 - dist, 4)   # cosine distance → similarity
            if score < 0.2:              # too dissimilar — skip
                continue
            results.append({
                "text":     doc,
                "score":    score,
                "source":   src,
                "metadata": meta,
            })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:top_k]


def format_results(results: list[dict], question: str) -> str:
    """Human-readable output for CLI and prompt injection."""
    if not results:
        return "No relevant results found in the knowledge base."
    if results and "error" in results[0]:
        return f"RAG error: {results[0]['error']}"

    lines = [f"RAG SEARCH: '{question}'", "─" * 60]
    for i, r in enumerate(results, 1):
        src   = r.get("source", "?")
        score = r.get("score", 0)
        meta  = r.get("metadata", {})
        text  = r.get("text", "")[:300]

        # Source-specific label
        if src == "trades":
            label = f"TRADE — {meta.get('symbol','')} {meta.get('setup','')} {meta.get('outcome','')} [{meta.get('date','')}]"
        elif src == "lessons":
            label = f"SETUP — {meta.get('setup','')} ({meta.get('win_rate','')}% WR, {meta.get('usable','')})"
        elif src == "memory":
            label = f"MEMORY — {meta.get('key','')} [{meta.get('tag','')}]"
        elif src == "vault":
            label = f"VAULT — {meta.get('file','')} chunk {meta.get('chunk','')}"
        else:
            label = f"{src}"

        lines.append(f"\n[{i}] {label}  (score {score:.3f})")
        lines.append(f"    {text}{'...' if len(r.get('text','')) > 300 else ''}")

    lines.append("─" * 60)
    return "\n".join(lines)


def main():
    if not DEPS_OK:
        print("ERROR: Missing dependencies. Run:")
        print("  pip install chromadb sentence-transformers")
        return 1

    argv = sys.argv[1:]
    if not argv or argv[0].startswith("--"):
        print("Usage: python tasks/rag_query.py 'your question' [--top N] [--source trades,memory,vault]")
        print("Run python tasks/rag_index.py first to build the index.")
        return 1

    question   = argv[0]
    top_k      = 5
    src_filter = None

    for i, a in enumerate(argv):
        if a == "--top" and i + 1 < len(argv):
            try:
                top_k = int(argv[i + 1])
            except ValueError:
                pass
        if a == "--source" and i + 1 < len(argv):
            src_filter = [s.strip() for s in argv[i + 1].split(",")]

    results = query(question, top_k=top_k, sources=src_filter)
    print(format_results(results, question))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
