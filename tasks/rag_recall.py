"""
Episodic trade recall — find similar past trades using semantic similarity.

  python tasks/rag_recall.py "Gold squeeze long"
  python tasks/rag_recall.py "BTC momentum breakout" --top 5
  python tasks/rag_recall.py "Gold LONG 65%" --top 3

Returns: similar past trades with outcome and R, plus a win-rate pattern summary.
Used by JARVIS to answer "the last N times this setup appeared, what happened?"

Requirements:
  pip install chromadb sentence-transformers (already installed if rag_index.py ran)
"""

import sys
from pathlib import Path

# Windows consoles on this fleet default to cp1252, and this script's own output uses
# the arrows, box characters and en-dashes every other report here uses. Printing them
# raised UnicodeEncodeError and killed /recall AFTER the search had already run and
# succeeded — the work was done and thrown away at the last line, which reads exactly
# like the search failing. Scheduled runs inherit the same codepage, so this is not a
# terminal-only concern. Guarded because reconfigure() is 3.7+ and a detached stdout
# has no reconfigure at all; a console that cannot be switched must not take the
# script down with it.
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

MODEL_NAME  = "all-MiniLM-L6-v2"
MIN_SCORE   = 0.30   # higher threshold than general search — trades must be genuinely similar
_model_cache = None


def _get_model():
    global _model_cache
    if _model_cache is None:
        # show_progress_bar WAS a constructor argument and is not one in
        # sentence-transformers 6.x — it moved to encode(). Passing it here raised
        # TypeError: SentenceTransformer.__init__() got an unexpected keyword argument
        # 'show_progress_bar', which killed /recall outright on this box. The intent
        # (no progress bar noise in a scripted call) is preserved at the encode call
        # below, where the argument actually lives now.
        _model_cache = SentenceTransformer(MODEL_NAME)
    return _model_cache


def _get_client():
    if not DB_DIR.exists():
        return None
    return chromadb.PersistentClient(path=str(DB_DIR))


def recall(context: str, top_k: int = 5) -> dict:
    """
    Find similar past trades and summarise the pattern.

    Args:
        context: natural language trade context — e.g. "Gold LONG squeeze 65%"
        top_k:   max similar trades to return

    Returns dict:
        {
          "trades":  [{text, score, symbol, setup, direction, outcome, date}],
          "summary": "3 similar trades — 2 WIN / 1 LOSS — avg +0.8R",
          "pattern": "BULLISH" | "BEARISH" | "MIXED" | "INSUFFICIENT",
          "count":   int,
        }
    """
    if not DEPS_OK:
        return {"error": "chromadb/sentence-transformers not installed"}

    client = _get_client()
    if client is None:
        return {"error": "RAG index not found — run python tasks/rag_index.py"}

    try:
        col = client.get_collection("trades")
    except Exception:
        return {"error": "Trades collection not found — run python tasks/rag_index.py --source trades"}

    count = col.count()
    if count == 0:
        return {"error": "Trades collection is empty — run python tasks/rag_index.py --source trades with server running"}

    model     = _get_model()
    embedding = model.encode([context], show_progress_bar=False).tolist()[0]

    res = col.query(
        query_embeddings=[embedding],
        n_results=min(top_k, count),
        include=["documents", "metadatas", "distances"],
    )

    docs      = res.get("documents", [[]])[0]
    metas     = res.get("metadatas", [[]])[0]
    distances = res.get("distances", [[]])[0]

    trades = []
    for doc, meta, dist in zip(docs, metas, distances):
        score = round(1 - dist, 4)
        if score < MIN_SCORE:
            continue
        trades.append({
            "text":      doc,
            "score":     score,
            "symbol":    meta.get("symbol", ""),
            "setup":     meta.get("setup", ""),
            "direction": meta.get("direction", ""),
            "outcome":   meta.get("outcome", ""),
            "date":      meta.get("date", ""),
        })

    trades.sort(key=lambda t: t["score"], reverse=True)

    # Pattern analysis
    wins   = [t for t in trades if str(t["outcome"]).upper() in ("WIN", "TP", "PROFIT")]
    losses = [t for t in trades if str(t["outcome"]).upper() in ("LOSS", "SL", "STOP")]
    n      = len(trades)

    if n == 0:
        pattern = "INSUFFICIENT"
        summary = f"No similar past trades found (threshold {MIN_SCORE})."
    elif n < 3:
        pattern = "INSUFFICIENT"
        summary = f"{n} similar trade(s) found — too few to judge pattern."
    else:
        wr = round(len(wins) / n * 100)
        if wr >= 60:
            pattern = "BULLISH" if any(t["direction"].upper() in ("BUY","LONG") for t in wins) else "POSITIVE"
        elif wr <= 40:
            pattern = "BEARISH" if any(t["direction"].upper() in ("SELL","SHORT") for t in losses) else "NEGATIVE"
        else:
            pattern = "MIXED"
        summary = f"{n} similar trade(s) — {len(wins)} WIN / {len(losses)} LOSS / {n - len(wins) - len(losses)} OTHER — {wr}% win rate"

    return {
        "trades":  trades,
        "summary": summary,
        "pattern": pattern,
        "count":   n,
    }


def format_recall(result: dict, context: str) -> str:
    """Human-readable episodic recall output."""
    if "error" in result:
        return f"RECALL ERROR: {result['error']}"

    lines = [
        f"EPISODIC RECALL: '{context}'",
        "─" * 60,
        f"Pattern: {result['pattern']} — {result['summary']}",
        "",
    ]

    if not result["trades"]:
        lines.append("  No similar past trades found.")
    else:
        for i, t in enumerate(result["trades"], 1):
            outcome_tag = {
                "WIN": "✅ WIN", "TP": "✅ WIN", "PROFIT": "✅ WIN",
                "LOSS": "❌ LOSS", "SL": "❌ LOSS", "STOP": "❌ LOSS",
            }.get(str(t["outcome"]).upper(), f"— {t['outcome']}")

            lines.append(
                f"  [{i}] {t['date'][:10]}  {t['symbol']} {t['direction'].upper()} "
                f"{t['setup']}  →  {outcome_tag}  (sim {t['score']:.2f})"
            )
            if t["text"]:
                note = t["text"]
                # Show just the note portion if present
                if "Outcome:" in note:
                    note_part = note.split("Outcome:")[-1].strip()[:120]
                    lines.append(f"         {note_part}")

    lines.append("─" * 60)
    return "\n".join(lines)


def main():
    if not DEPS_OK:
        print("ERROR: pip install chromadb sentence-transformers")
        return 1

    argv = sys.argv[1:]
    if not argv or argv[0].startswith("--"):
        print("Usage: python tasks/rag_recall.py 'Gold squeeze LONG' [--top N]")
        return 1

    context = argv[0]
    top_k   = 5

    for i, a in enumerate(argv):
        if a == "--top" and i + 1 < len(argv):
            try:
                top_k = int(argv[i + 1])
            except ValueError:
                pass

    result = recall(context, top_k=top_k)
    print(format_recall(result, context))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
