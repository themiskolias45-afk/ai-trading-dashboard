"""
Economic Calendar Context — fetches upcoming high-impact events and formats
them for injection into signal analysis prompts.

  python tasks/economic_calendar.py [--days N] [--json]

Uses the ForexFactory calendar RSS feed (free, no API key).
Filters for HIGH and MEDIUM impact events affecting USD, GBP, EUR, XAU.

Usage from other scripts:
  from tasks.economic_calendar import get_upcoming_events
  events = get_upcoming_events(days=3)

Output format (--json):
  [{"date":"...", "time":"...", "currency":"USD", "impact":"HIGH", "event":"NFP", "forecast":"..."}]

Plain output:
  UPCOMING HIGH-IMPACT EVENTS (next 3 days)
  2026-09-05 13:30 UTC  USD  [HIGH]  Non-Farm Payrolls  Forecast: 180K
  ...

WHAT IT DOES NOT DO
  - Never touches trading data, learning.json, journal, or signals
  - Never executes trades or changes settings
  - Falls back silently if the feed is unavailable (returns empty list)
"""

import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT       = Path(__file__).parent.parent
CACHE_PATH = ROOT / "tasks" / "economic_calendar_cache.json"
CACHE_TTL  = 3600  # seconds — re-fetch at most once per hour

FF_RSS = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml"

HIGH_CURRENCIES = {"USD", "GBP", "EUR", "XAU", "GBP", "JPY"}
HIGH_IMPACT     = {"High", "HIGH", "3", "Medium", "MEDIUM", "2"}


def _load_cache() -> list:
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        fetched_at = datetime.fromisoformat(data.get("fetched_at", "2000-01-01"))
        age = (datetime.now(timezone.utc) - fetched_at.replace(tzinfo=timezone.utc)).total_seconds()
        if age < CACHE_TTL:
            return data.get("events", [])
    except Exception:
        pass
    return []


def _save_cache(events: list):
    try:
        payload = {
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "events": events,
        }
        CACHE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass


def _fetch_ff() -> list:
    """Fetch ForexFactory RSS and return list of event dicts."""
    try:
        req = urllib.request.Request(FF_RSS, headers={"User-Agent": "SmartEntry/1.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            xml_bytes = r.read()
    except Exception as exc:
        return []

    events = []
    try:
        root = ET.fromstring(xml_bytes)
        for item in root.iter("event"):
            currency = (item.findtext("country") or "").upper()
            impact   = (item.findtext("impact") or "").strip()
            if currency not in HIGH_CURRENCIES:
                continue
            if impact not in HIGH_IMPACT:
                continue
            events.append({
                "date":     item.findtext("date") or "",
                "time":     item.findtext("time") or "",
                "currency": currency,
                "impact":   "HIGH" if impact in {"High", "HIGH", "3"} else "MEDIUM",
                "event":    item.findtext("title") or "",
                "forecast": item.findtext("forecast") or "",
                "previous": item.findtext("previous") or "",
            })
    except ET.ParseError:
        pass

    return events


def get_upcoming_events(days: int = 3) -> list:
    """Return events in the next N days. Cached for CACHE_TTL seconds."""
    events = _load_cache()
    if not events:
        events = _fetch_ff()
        _save_cache(events)

    cutoff = datetime.now(timezone.utc) + timedelta(days=days)
    now    = datetime.now(timezone.utc)

    upcoming = []
    for ev in events:
        raw_date = ev.get("date", "")
        raw_time = ev.get("time", "")
        try:
            dt_str = f"{raw_date} {raw_time}".strip()
            if dt_str:
                ev_dt = datetime.strptime(dt_str, "%m-%d-%Y %H:%M")
                ev_dt = ev_dt.replace(tzinfo=timezone.utc)
                if now <= ev_dt <= cutoff:
                    upcoming.append({**ev, "iso": ev_dt.isoformat()})
        except ValueError:
            continue

    upcoming.sort(key=lambda e: e.get("iso", ""))
    return upcoming


def format_for_prompt(events: list) -> str:
    """Format for injection into a Claude prompt."""
    if not events:
        return "No high-impact economic events in the next 3 days."
    lines = ["UPCOMING HIGH-IMPACT EVENTS:"]
    for ev in events:
        impact_tag = f"[{ev['impact']}]"
        fc = f" Forecast: {ev['forecast']}" if ev.get("forecast") else ""
        pr = f" Prev: {ev['previous']}" if ev.get("previous") else ""
        lines.append(f"  {ev.get('date','')} {ev.get('time','')} UTC  "
                     f"{ev['currency']}  {impact_tag}  {ev['event']}{fc}{pr}")
    return "\n".join(lines)


def main():
    argv  = sys.argv[1:]
    days  = 3
    as_json = "--json" in argv
    for i, a in enumerate(argv):
        if a == "--days" and i + 1 < len(argv):
            try:
                days = int(argv[i + 1])
            except ValueError:
                pass

    events = get_upcoming_events(days=days)

    if as_json:
        print(json.dumps(events, indent=2))
    else:
        print(format_for_prompt(events))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
