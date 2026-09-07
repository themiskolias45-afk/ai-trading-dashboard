# Aggregates tasks/all_trades_ledger.jsonl into tasks/trade_ledger_summary.json.
#
# WHY. The ledger is the only record that pools BOTH accounts and BOTH boxes from broker
# truth, and it is the only place the executor models appear at all - the FVG trades of
# 2026-09-03/04 (+94.74 and +204.93) reached neither box's journal. But 12,453 raw rows
# are not something a person or the learning engine can read. This turns them into the
# per-model record that did not exist: how each strategy is ACTUALLY doing, live, net.
#
# READ-ONLY AND UNABLE TO BLOCK. It reads one file and writes one file that nothing
# trades from. It touches no gate, no threshold, no setting, no signal path, no journal
# and no other ledger. If it fails, nothing changes anywhere.
#
# feedsTheGate is false and stays false, for the same reason it is false on the shadow
# ledgers: a live P&L table that silently reweights the engine is how a bad month starts
# suppressing the setups that would end it. This is a MEASUREMENT surface. Deciding that
# a model should trade more or less is a human call made on these numbers, not an
# automatic consequence of them.
import json, os
from collections import defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
LEDGER = os.path.join(HERE, "all_trades_ledger.jsonl")
OUT = os.path.join(HERE, "trade_ledger_summary.json")
# Second copy under dashboard/, which server/index.js serves statically behind the same
# login gate as every other surface (index.js:9922). Publishing here rather than adding an
# /api route means NO server edit and NO restart of a live trading server for a read-only
# feature - and it inherits the auth gate instead of opening a new unguarded one.
DASH_OUT = os.path.join(HERE, "..", "dashboard", "trade-ledger-summary.json")


# Magic -> model, resolved at READ time. The ledger is append-only and rows written
# before a magic was recognised carry "unknown_magic_N" for ever; rewriting them to
# relabel would violate the one guarantee that file makes. So the mapping lives here,
# where it can be corrected without touching a byte of the record.
MAGIC_MODEL = {
    20250101: "SmartEntry_bridge",
    20260902: "FVG_CONTINUATION",
    20260903: "TK_SWING_PULLBACK",
    20260904: "CRT_FVG",
    26070401: "EA_CRT_AMD_Dashboard",
    26070402: "EA_CRT_AMD_Dashboard",   # second instance of the same EA, July trial
    26070455: "EA_CRT_AMD_Dashboard_v355",
}


# The chart EA is NOT part of SmartEntry and must never be pooled with it. It is a
# standalone MT5 expert with its own magic, its own config and its own record; SmartEntry
# is the bridge plus its strategy executors. Averaging the two produces a "system" number
# that describes neither, and an EA problem would hide inside SmartEntry's totals (or the
# reverse). They are reported side by side and never summed.
CHART_EA_MAGICS = {26070401, 26070402, 26070455}


def resolve(row):
    """Model and owner from the magic, falling back to whatever the row stored."""
    magic = row.get("magic")
    model = MAGIC_MODEL.get(magic)
    if model:
        owner = ("smartentry" if magic == 20250101
                 else "chart_ea" if magic in CHART_EA_MAGICS
                 else "executor")
        row = dict(row, model=model, owner=owner)
    return row


def load():
    rows = []
    if not os.path.exists(LEDGER):
        return rows
    with open(LEDGER, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            # One malformed row must not hide the 12,000 good ones on either side of it.
            try:
                rows.append(resolve(json.loads(line)))
            except ValueError:
                continue
    return rows


def stats(rows):
    """Plain arithmetic on realised broker P&L. No modelling, no assumed costs: swap and
    commission are already inside netProfit, so this is what the account actually did."""
    n = len(rows)
    if not n:
        return None
    nets = [r.get("netProfit") or 0.0 for r in rows]
    wins = [x for x in nets if x > 0]
    losses = [x for x in nets if x < 0]
    gross_win = sum(wins)
    gross_loss = -sum(losses)
    rows_sorted = sorted(rows, key=lambda r: r.get("closeTime") or "")
    return {
        "trades": n,
        "wins": len(wins),
        "losses": len(losses),
        # Scratches (exactly 0.00) are neither, so this is reported rather than inferred
        # from trades-minus-wins, which would quietly count them as losses.
        "scratches": n - len(wins) - len(losses),
        "winRatePct": round(len(wins) * 100.0 / n, 2),
        "netProfit": round(sum(nets), 2),
        "grossProfit": round(gross_win, 2),
        "grossLoss": round(-gross_loss, 2),
        # None, never 0 or 99: a model with no losing trade yet has an UNDEFINED profit
        # factor, and printing a number there would read as a finished verdict.
        "profitFactor": round(gross_win / gross_loss, 3) if gross_loss > 0 else None,
        "expectancyPerTrade": round(sum(nets) / n, 2),
        "largestWin": round(max(nets), 2),
        "largestLoss": round(min(nets), 2),
        "firstClose": rows_sorted[0].get("closeTime"),
        "lastClose": rows_sorted[-1].get("closeTime"),
    }


def group(rows, key):
    out = {}
    buckets = defaultdict(list)
    for r in rows:
        buckets[str(r.get(key))].append(r)
    for name, group_rows in buckets.items():
        s = stats(group_rows)
        if s:
            out[name] = s
    # Best net first: the question asked of this file is almost always "which is working".
    return dict(sorted(out.items(), key=lambda kv: -kv[1]["netProfit"]))


def main():
    rows = load()
    # SmartEntry = the bridge + its executors. The chart EA is kept out deliberately.
    ours = [r for r in rows if r.get("owner") in ("smartentry", "executor")]
    chart_ea = [r for r in rows if r.get("owner") == "chart_ea"]
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "ledger": os.path.basename(LEDGER),
        "feedsTheGate": False,
        "totalRowsInLedger": len(rows),
        # Everything this system placed, separated from the third-party EAs sharing the
        # accounts. Pooling them would credit our models with other people's trades.
        "smartEntry": stats(ours),
        # Reported separately, never merged into smartEntry. See CHART_EA_MAGICS.
        "crtDashboardEA": stats(chart_ea),
        "crtDashboardEAByModel": group(chart_ea, "model"),
        "separationNote": ("EA_CRT_AMD_Dashboard is a standalone MT5 expert, not part of "
                           "SmartEntry. The two are never summed."),
        "byOwner": group(rows, "owner"),
        "byModel": group(ours, "model"),
        "byAccount": group(ours, "account"),
        "bySymbol": group(ours, "symbol"),
        "foreignNote": ("owner=foreign are third-party EAs on the same accounts. Counted "
                        "separately and never merged into model performance."),
    }
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1)
    os.replace(tmp, OUT)   # atomic: a reader never sees a half-written file

    # Same payload, published for the dashboard. Failure to publish must never lose the
    # canonical copy already written above, so this is reported and swallowed.
    try:
        dash = os.path.abspath(DASH_OUT)
        dtmp = dash + ".tmp"
        with open(dtmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=1)
        os.replace(dtmp, dash)
    except OSError as exc:
        print("could not publish to dashboard/: %s" % exc)

    sp = payload["smartEntry"] or {}
    ea = payload["crtDashboardEA"] or {}
    print("SmartEntry (bridge + executors): %s trades, net %s, PF %s, win %s%%"
          % (sp.get("trades"), sp.get("netProfit"), sp.get("profitFactor"), sp.get("winRatePct")))
    print("CRT Dashboard EA (separate):     %s trades, net %s, PF %s, win %s%%"
          % (ea.get("trades"), ea.get("netProfit"), ea.get("profitFactor"), ea.get("winRatePct")))
    for model, s in payload["byModel"].items():
        print("   %-28s %4d trades  net %9.2f  PF %-7s  win %5.1f%%"
              % (model, s["trades"], s["netProfit"],
                 s["profitFactor"] if s["profitFactor"] is not None else "n/a",
                 s["winRatePct"]))
    print("summary: %s" % OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
