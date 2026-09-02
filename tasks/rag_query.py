"""
RAG Query — semantic search over the indexed trading knowledge base.

  python tasks/rag_query.py "has Gold rejected at 2400 before?"
  python tasks/rag_query.py "what setups work best in trending markets?" --top 5
  python tasks/rag_query.py "RANGE_TRADE_LONG performance" --source trades
  python tasks/rag_query.py "what did JARVIS learn about RSI ceiling?" --source memory,vault
  python tasks/rag_query.py "why does it buy when the 4H is bearish?" --source brain

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

# Windows consoles on this fleet default to cp1252, and format_results prints the box
# characters and en-dashes every report here uses. Without this the query RUNS, the
# search SUCCEEDS, and the process dies on the last print with UnicodeEncodeError --
# which reads exactly like the search failing. Measured on the VPS 2026-09-01:
# "'charmap' codec can't encode characters in position 50-109".
# tasks/rag_recall.py already carried this guard; this file did not, and the pair was
# only ever exercised on the laptop where the codepage happened to be fine.
# Guarded because reconfigure() is 3.7+ and a detached stdout has no reconfigure at
# all; a console that cannot be switched must not take the script down with it.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass

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

    # "decisions" leads the default list on purpose. When a question is about whether
    # something may be changed, a STANDING DECISION outranks a memory of measuring it:
    # the memory says what was learned, the decision says what was settled. On
    # 2026-09-02 an agent found the measurement and missed the decision, and shipped a
    # change that had already been reversed once.
    all_sources = sources or ["decisions", "brain", "trades", "lessons", "memory", "vault"]
    results     = []

    for src in all_sources:
        try:
            col = client.get_collection(src)
        except Exception:
            continue

        count = col.count()
        if count == 0:
            continue
        res = col.query(
            query_embeddings=[embedding],
            n_results=min(top_k, count),
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

    # A MATCHING STANDING DECISION IS NEVER CUT BY top_k.
    #
    # The truncation used to happen here, before anything could notice what was being
    # dropped. Measured 2026-09-02 on the real query "is it ok to add price level lines to
    # the chart": two brain memories scored 0.509 and 0.446, and the STANDING DECISION
    # forbidding exactly that scored 0.367 and fell outside --top 3. On that day all three
    # said the same thing, which was luck. The next time a memory of what was LEARNED
    # outranks a rule about what was SETTLED, the one that got cut is the one that decides
    # whether the change is permitted.
    #
    # So the top_k cut applies to the ranked list, and any decision that cleared the
    # similarity floor is added back. It can only ever ADD rows, never displace one.
    top = results[:top_k]
    shown = {id(r) for r in top}
    for r in results:
        if r.get("source") == "decisions" and id(r) not in shown:
            top.append(r)
    return top


def format_results(results: list[dict], question: str) -> str:
    """Human-readable output for CLI and prompt injection."""
    if not results:
        return "No relevant results found in the knowledge base."
    if results and "error" in results[0]:
        return f"RAG error: {results[0]['error']}"

    lines = [f"RAG SEARCH: '{question}'", "─" * 60]

    # STANDING DECISIONS GO FIRST, ALWAYS, WHENEVER ONE MATCHES AT ALL.
    #
    # They are ranked like everything else and they lose, because a memory that narrates
    # an incident uses more of the question's words than a rule that governs it. Measured
    # 2026-09-02 on the real query "is it ok to add price level lines to the chart": two
    # brain memories scored 0.509 and 0.446, the STANDING DECISION that forbids exactly
    # that scored 0.367 and fell outside --top 3. Both said the same thing that day, which
    # is luck, not design — the next time they disagree, the one that got cut is the one
    # that decides whether the change is allowed.
    #
    # "What was learned" and "what was settled" are different questions. Ranking cannot
    # tell them apart, so the answer to the second is never left to ranking.
    decisions = [r for r in results if r.get("source") == "decisions"]
    if decisions:
        lines.append("STANDING DECISIONS MATCH THIS QUESTION — read before changing anything:")
        for d in decisions[:3]:
            where = (d.get("metadata") or {}).get("name", "?")
            lines.append(f"  ! {where}   (score {d.get('score', 0)})")
        lines.append("  full text: node tasks/decisions.cjs check \"" + question.replace('"', "'") + "\"")
        lines.append("─" * 60)
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
        elif src == "brain":
            # The FILENAME is the payload here: the caller's next move is to open
            # that memory, and a hit that does not name the file cannot be acted on.
            label = (f"BRAIN — {meta.get('file','')} [{meta.get('type','')}]"
                     f"  {meta.get('description','')[:90]}")
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
