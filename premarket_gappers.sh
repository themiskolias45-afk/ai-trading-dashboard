#!/usr/bin/env bash
#
# PREMARKET GAPPERS SCANNER - POSIX shell version.
#
# READ-ONLY, AND DELIBERATELY SO. It places no order, touches no journal, no
# learning record, no calibration record, no gate and no setting. It writes
# nothing anywhere unless you pass --json, and then only to the path you name.
# Nothing in SmartEntry reads its output. It is a screening tool: a list of names
# to look at, never a signal and never a fill.
#
# WHERE THIS RUNS. The laptop, via Git Bash. NOT the VPS - measured 2026-09-17,
# `where bash` there returns "Could not find files for the given pattern(s)". The
# VPS has curl, python and node but no shell that can run this file. For the box
# that trades, use premarket_gappers.ps1 beside this one: same logic, same output,
# and verified on both machines. This file exists because a shell script was asked
# for; it is not a substitute for that one.
#
# DEPENDENCIES: bash, curl, python. jq is NOT used - it is absent on this machine
# (`command -v jq` -> nothing), and a scanner that needs a tool the box does not
# have is a scanner that does not run. Python does the JSON and the arithmetic;
# the shell does the orchestration.
#
# DATA: Yahoo's chart endpoint, the same one tasks/fetch_yahoo_history.cjs already
# uses. No API key, no account, no secret - nothing here to leak.
#
# HOW THE GAP IS COMPUTED:
#   gap% = (last premarket print - previous regular close) / previous close * 100
# The premarket window comes from meta.currentTradingPeriod in the payload, NOT
# from the local clock. Those windows move with DST and per exchange, and a
# hardcoded 09:30 ET is how a scanner quietly reports nothing for half the year.
#
# PREMARKET VOLUME IS NOT AVAILABLE and this script says so rather than implying
# otherwise. Measured 2026-09-17: Yahoo returns 1-minute premarket volume as a
# literal 0, not null - AMD had 328 premarket bars, all non-null, all zero.
# Printing 0 would claim "measured, and there was none". It prints n/a, and
# --min-volume is REFUSED with a warning rather than silently matching nothing,
# which would look exactly like a quiet market.
#
# USAGE
#   ./premarket_gappers.sh
#   ./premarket_gappers.sh --min-gap 4 --min-price 10
#   ./premarket_gappers.sh --symbols NVDA,AMD,TSLA
#   ./premarket_gappers.sh --from-history
#   ./premarket_gappers.sh --json /tmp/gappers.json
#
# EXIT CODES
#   0  scan completed (even if nothing passed - an empty market is an answer)
#   1  every symbol failed to fetch, so the run says nothing about the market
#   2  bad arguments or a missing dependency

set -u

MIN_GAP=2.0
MIN_PRICE=5.0
MIN_VOLUME=0
THROTTLE=0.35
TIMEOUT=20
JSON_OUT=""
SYMBOLS=""
FROM_HISTORY=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Liquid US names and ETFs where a premarket gap is tradeable at all. Deliberately
# short: a scan over 500 thin tickers reports noise and takes three minutes doing it.
DEFAULT_UNIVERSE="AAPL MSFT NVDA AMD AMZN GOOGL META TSLA AVGO NFLX \
INTC MU PLTR COIN MSTR SMCI BA DIS JPM BAC \
PFE XOM WMT SPY QQQ IWM GLD TLT SOXL ARKK"

usage() { sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --min-gap)     MIN_GAP="${2:-}";     shift 2 ;;
    --min-price)   MIN_PRICE="${2:-}";   shift 2 ;;
    --min-volume)  MIN_VOLUME="${2:-}";  shift 2 ;;
    --throttle)    THROTTLE="${2:-}";    shift 2 ;;
    --timeout)     TIMEOUT="${2:-}";     shift 2 ;;
    --json)        JSON_OUT="${2:-}";    shift 2 ;;
    --symbols)     SYMBOLS="${2:-}";     shift 2 ;;
    --from-history) FROM_HISTORY=1;      shift ;;
    -h|--help)     usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done

for dep in curl python; do
  command -v "$dep" >/dev/null 2>&1 || { echo "missing dependency: $dep" >&2; exit 2; }
done

# ---------------------------------------------------------------- universe

build_universe() {
  if [ -n "$SYMBOLS" ]; then
    # Split on commas AND whitespace, so --symbols "NVDA,AMD" and "NVDA AMD" both work.
    echo "$SYMBOLS" | tr ',' ' ' | tr '[:lower:]' '[:upper:]'
    return
  fi
  if [ "$FROM_HISTORY" -eq 1 ]; then
    hist="$SCRIPT_DIR/tasks/history_yahoo"
    if [ ! -d "$hist" ]; then
      echo "--from-history: $hist does not exist, using the built-in list" >&2
      echo "$DEFAULT_UNIVERSE"; return
    fi
    # Strip the _D1/_H1/_H4/_M15 suffix; drop FX pairs, metals, indices and the
    # Y-prefixed Yahoo-only rows - none of them have a US premarket session.
    found=$(ls "$hist"/*.csv 2>/dev/null \
      | sed 's#.*/##; s/\.csv$//; s/_\(D1\|H1\|H4\|M15\)$//' \
      | grep -Ev '^(XAU|XAG|BTC|ETH|LTC|EUR|GBP|AUD|USD|SP500|NAS100|zBASE)' \
      | grep -E '^[A-Z.]{1,6}$' | sort -u | tr '\n' ' ')
    if [ -z "$(echo "$found" | tr -d ' ')" ]; then
      echo "--from-history: no usable tickers found, using the built-in list" >&2
      echo "$DEFAULT_UNIVERSE"; return
    fi
    echo "$found"; return
  fi
  echo "$DEFAULT_UNIVERSE"
}

UNIVERSE="$(build_universe)"
COUNT=$(echo "$UNIVERSE" | wc -w | tr -d ' ')
NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)

TMPDIR_RUN="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/pmg.$$")"
mkdir -p "$TMPDIR_RUN"
RESULTS="$TMPDIR_RUN/results.ndjson"
: > "$RESULTS"
# The ONLY thing this script deletes is its own scratch directory.
trap 'rm -rf "$TMPDIR_RUN"' EXIT INT TERM

echo ""
echo "PREMARKET GAPPERS - read-only screen, places no orders"
echo "  as of $NOW_UTC   symbols $COUNT   filters: |gap| >= ${MIN_GAP}%, price >= ${MIN_PRICE}, vol >= ${MIN_VOLUME}"
echo ""

# ---------------------------------------------------------------- fetch

# One python parser, fed each symbol's raw JSON on stdin. Emits a single NDJSON
# line. Kept out of the loop body so the quoting is written once and only once.
PARSER="$TMPDIR_RUN/parse.py"
cat > "$PARSER" <<'PYEOF'
import json, sys, datetime

symbol = sys.argv[1]

def emit(obj):
    obj["symbol"] = symbol
    sys.stdout.write(json.dumps(obj) + "\n")

try:
    payload = json.load(sys.stdin)
except Exception as exc:
    emit({"ok": False, "error": "unparseable response: %s" % exc}); sys.exit(0)

chart = payload.get("chart") or {}
results = chart.get("result")
if not results:
    err = chart.get("error") or {}
    emit({"ok": False, "error": err.get("description") or "no result block"}); sys.exit(0)

res = results[0]
meta = res.get("meta") or {}
prev_close = meta.get("chartPreviousClose")
if not prev_close or prev_close <= 0:
    emit({"ok": False, "error": "no previous close"}); sys.exit(0)

# Session windows from the payload, never from the local clock.
period = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
regular_start = period.get("start")
if regular_start is None:
    emit({"ok": False, "error": "no regular session window"}); sys.exit(0)

stamps = res.get("timestamp") or []
quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
closes = quote.get("close") or []
volumes = quote.get("volume") or []

last_price = last_at = None
pre_volume = 0
pre_bars = 0
for i, ts in enumerate(stamps):
    if i >= len(closes):
        break
    close = closes[i]
    if close is None or ts >= regular_start:
        continue
    last_price, last_at = float(close), ts
    pre_bars += 1
    if i < len(volumes) and volumes[i]:
        pre_volume += float(volumes[i])

if last_price is None:
    # Not an error: outside premarket hours, a weekend, or a name with no premarket
    # trade. All three are legitimate and must not read as a failed fetch.
    emit({"ok": True, "hasPremarket": False, "prevClose": round(float(prev_close), 4)})
    sys.exit(0)

gap = (last_price - prev_close) / prev_close * 100.0
emit({
    "ok": True,
    "hasPremarket": True,
    "prevClose": round(float(prev_close), 4),
    "premarketPrice": round(last_price, 4),
    "gapPercent": round(gap, 2),
    "direction": "UP" if gap >= 0 else "DOWN",
    # None, never 0, when the feed supplied no volume - see the header. An
    # unmeasurable quantity must not filter or average as if it were a reading.
    "premarketVolume": int(pre_volume) if pre_volume > 0 else None,
    "premarketBars": pre_bars,
    "lastPrintUtc": datetime.datetime.utcfromtimestamp(last_at).strftime("%Y-%m-%dT%H:%M:%SZ"),
})
PYEOF

FAILED=0
IDX=0
for sym in $UNIVERSE; do
  IDX=$((IDX + 1))
  url="https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1m&includePrePost=true"
  body=$(curl -s --max-time "$TIMEOUT" -H "User-Agent: Mozilla/5.0" "$url" 2>/dev/null || true)
  if [ -z "$body" ]; then
    printf '{"symbol":"%s","ok":false,"error":"empty response"}\n' "$sym" >> "$RESULTS"
    FAILED=$((FAILED + 1))
  else
    line=$(printf '%s' "$body" | python "$PARSER" "$sym" 2>/dev/null || true)
    if [ -z "$line" ]; then
      printf '{"symbol":"%s","ok":false,"error":"parser produced nothing"}\n' "$sym" >> "$RESULTS"
      FAILED=$((FAILED + 1))
    else
      echo "$line" >> "$RESULTS"
      echo "$line" | grep -q '"ok": false' && FAILED=$((FAILED + 1))
    fi
  fi
  [ "$IDX" -lt "$COUNT" ] && sleep "$THROTTLE"
done

# Every fetch failing means this run says NOTHING about the market. That is a
# different outcome from "the market is quiet" and must not exit 0.
if [ "$FAILED" -ge "$COUNT" ] && [ "$COUNT" -gt 0 ]; then
  echo "ALL $FAILED symbol(s) failed to fetch - this run says NOTHING about the market."
  head -3 "$RESULTS"
  exit 1
fi

# ---------------------------------------------------------------- report

python - "$RESULTS" "$MIN_GAP" "$MIN_PRICE" "$MIN_VOLUME" "$FAILED" "$NOW_UTC" "$JSON_OUT" <<'PYEOF'
import json, sys

path, min_gap, min_price, min_vol, failed, now_utc, json_out = sys.argv[1:8]
min_gap, min_price, min_vol, failed = float(min_gap), float(min_price), float(min_vol), int(failed)

rows = []
with open(path) as handle:
    for line in handle:
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass

with_pre = [r for r in rows if r.get("ok") and r.get("hasPremarket")]
vol_available = any(r.get("premarketVolume") is not None for r in with_pre)
vol_dropped = min_vol > 0 and not vol_available

def passes(row):
    if abs(row["gapPercent"]) < min_gap:
        return False
    if row["premarketPrice"] < min_price:
        return False
    if min_vol > 0 and vol_available:
        return row.get("premarketVolume") is not None and row["premarketVolume"] >= min_vol
    return True

hits = sorted([r for r in with_pre if passes(r)], key=lambda r: -abs(r["gapPercent"]))

if vol_dropped:
    print("NOTE: --min-volume %g was NOT applied. This feed returned no premarket volume" % min_vol)
    print("      for any symbol (Yahoo reports 1m premarket volume as 0). Filtering on it")
    print("      would have returned an empty list indistinguishable from a quiet market.")
    print("")

if hits:
    print("%-8s %8s %10s %9s %6s %12s  %s" %
          ("SYMBOL", "GAP %", "PREMARKET", "PREVCLOSE", "DIR", "PRE VOL", "LAST PRINT (UTC)"))
    print("-" * 78)
    for row in hits:
        vol = "n/a" if row.get("premarketVolume") is None else "{:,}".format(row["premarketVolume"])
        print("%-8s %+8.2f %10.2f %9.2f %6s %12s  %s" % (
            row["symbol"], row["gapPercent"], row["premarketPrice"],
            row["prevClose"], row["direction"], vol, row["lastPrintUtc"]))
else:
    print("No symbol passed the filter.")

no_pre = len([r for r in rows if r.get("ok") and not r.get("hasPremarket")])
print("")
print("scanned %d | with premarket trade %d | passed filter %d | no premarket %d | fetch failed %d"
      % (len(rows), len(with_pre), len(hits), no_pre, failed))
if len(with_pre) == 0:
    print("  (no premarket prints anywhere - outside premarket hours, or a weekend)")
if failed:
    print("  (%d symbol(s) could not be fetched and are NOT represented above)" % failed)
print("")
print("SCREEN ONLY. Not a signal, not a setup, and nothing in SmartEntry reads this.")

if json_out:
    try:
        payload = {
            "generatedAt": now_utc,
            "filters": {"minGapPercent": min_gap, "minPrice": min_price,
                        "minPremarketVolume": min_vol, "volumeFilterApplied": not vol_dropped},
            "scanned": len(rows), "failed": failed, "feedsTheGate": False,
            "results": rows,
        }
        with open(json_out, "w") as handle:
            json.dump(payload, handle, indent=2)
        print("wrote %s" % json_out)
    except Exception as exc:
        # A failed report write must not fail a scan that already succeeded.
        print("could not write %s: %s" % (json_out, exc))
PYEOF

exit 0
