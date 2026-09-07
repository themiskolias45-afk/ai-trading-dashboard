"""
generate_pine is a pure function, so the emitted Pine SOURCE can be asserted on
directly. This does not execute Pine - TradingView draws to a canvas and no DOM check
works on it, which is exactly why the chart has to carry its own age instead of being
verified from outside.

Run: python tests_tv_plan_staleness.py
"""
import importlib.util, time, sys

spec = importlib.util.spec_from_file_location("tvbot", "tradingview_bot.py")
tv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tv)

failures = []
def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else " - " + str(detail)))
    if not ok:
        failures.append(label)

def plan(ts_ms, stamp="2026-08-21 05:12", **kw):
    p = {"symbol": "GOLD", "generated_at": stamp, "bias": "WAIT", "decimals": 2,
         "rows": {k: "-" for k in tv.PLAN_ROWS},
         "entry": 4500.0, "stop": 4400.0, "target": 4700.0}
    if ts_ms is not None:
        p["generated_ts_ms"] = ts_ms
    p.update(kw)
    return p

now_ms = int(time.time() * 1000)

print("TV daily plan - chart carries its own age")

# 1. The regression: the date must survive into the header.
src = tv.generate_pine([plan(now_ms)])
# Scope this to the header CELL. The full timestamp also appears in a // comment, so
# a bare `"08-21 05:12" in src` passes even when the cell itself is back to HH:MM -
# the mutation test caught exactly that.
hdr = [l for l in src.splitlines() if "table.cell(planTable, 0, 0" in l][0]
check("header CELL carries the DATE, not just HH:MM", "08-21 05:12" in hdr, hdr)
check("header no longer emits a bare HH:MM stamp",
      '"JARVIS GOLD  05:12"' not in src)

# 2. A fresh plan must not be able to render as stale.
check("fresh plan embeds its timestamp", ("_planTs = %d" % now_ms) in src, )
check("fresh plan computes age from timenow", "_planAgeHrs = (timenow - _planTs) / 3600000.0" in src)
check("threshold is above the 17.5h overnight gap",
      "_planStale = _planAgeHrs > 18.0" in src)

# 3. Staleness must be decided ON the chart, not baked in at generation time.
old = tv.generate_pine([plan(now_ms - int(40 * 3600 * 1000))])
check("a 40h-old plan emits the same live comparison, not a frozen verdict",
      "_planStale = _planAgeHrs > 18.0" in old and "_planTs = %d" % (now_ms - 40*3600*1000) in old)
check("stale styling is wired to the header cell",
      "_planAgeSuffix, text_color=_planAgeColor" in src)
# Pine binds + tighter than ?: . Without the parens the suffix lands on the fallback
# branch alone and the marker never shows on a real symbol - found by reading the
# emitted source, not by any assertion that existed before.
check("header ternary is parenthesised so the suffix applies to EVERY branch",
      hdr.split("table.cell(planTable, 0, 0, ")[1].startswith("(")
      and ") + _planAgeSuffix" in hdr, hdr)
multi_hdr = [l for l in tv.generate_pine([plan(now_ms), plan(now_ms, symbol="BTC")]).splitlines()
             if "table.cell(planTable, 0, 0" in l][0]
check("multi-symbol header also parenthesised",
      multi_hdr.split("table.cell(planTable, 0, 0, ")[1].startswith("(")
      and ") + _planAgeSuffix" in multi_hdr, multi_hdr)
check("stale branch names the age in hours",
      'str.tostring(_planAgeHrs, "#.#")' in src)

# 4. An unknown age must read as unknown - never as fresh.
nots = tv.generate_pine([plan(None)])
check("missing timestamp says 'age unknown'", '_planAgeSuffix = "  (age unknown)"' in nots)
check("missing timestamp does not claim freshness",
      "_planStale" not in nots and "color.white" not in nots.split("_planAgeColor = ")[1].split("\n")[0])

# 5. build_plan must actually populate the field the rest of this depends on.
src_txt = open("tradingview_bot.py", encoding="utf-8").read()
check("build_plan records generated_ts_ms", '"generated_ts_ms": int(time.time() * 1000),' in src_txt)

# 6. Multi-symbol layout still emits one script (the Gold-rendering-BTC bug).
multi = tv.generate_pine([plan(now_ms), plan(now_ms, symbol="BTC")])
check("one indicator declaration for all symbols", multi.count("indicator(") == 1)
check("staleness declared once, not per symbol", multi.count("_planAgeHrs = ") == 1)


# 7. The legend title is the verification channel - a DOM probe on 2026-08-21 found
#    "JARVIS Daily Plan" was the ONLY JARVIS string on the page, carrying no version.
ind = [l for l in src.splitlines() if l.startswith("indicator(")][0]
check("indicator keeps the stable title (list_plan_studies matches on it)",
      ind.startswith("indicator(" + chr(34) + "JARVIS Daily Plan" + chr(34)), ind)
# shorttitle is kept because it shows in the study's settings dialog, but NOTHING
# gates on it - the legend does not display it. See test 8.
check("shorttitle still carries the stamp (informational only)",
      "shorttitle=" + chr(34) + "JARVIS Daily Plan 08-21 05:12" + chr(34) in ind, ind)
check("legend name keeps the prefix list_plan_studies filters on",
      tv.plan_legend_name("2026-08-21 05:12").startswith(tv.PLAN_NAME_PREFIX))

# 8. What the DOM can and cannot answer.
#    A stamp-in-the-legend check was tried and REMOVED: for a study added from a saved
#    user script the legend shows the SAVED SCRIPT NAME, so the stamp never appeared
#    and the check could never pass. A red light that cannot go green is worse than none.
real_list = tv.list_plan_studies
try:
    tv.list_plan_studies = lambda page: ["JARVIS Daily Plan"]
    check("a plan study on the chart is detected", tv.plan_study_present(None) is True)
    tv.list_plan_studies = lambda page: []
    check("no plan study is detected as absent", tv.plan_study_present(None) is False)
finally:
    tv.list_plan_studies = real_list
check("the unworkable stamp check is gone, not left dead",
      not hasattr(tv, "applied_plan_stamp"))

# 9. cmd_plan must not hardcode success - that single True is why a stale chart
#    reported a clean pass for fourteen days.
body = open("tradingview_bot.py", encoding="utf-8").read()
check("no hardcoded 'the plan is applied regardless' success",
      "the plan is applied regardless" not in body)
check("both screenshot paths follow the VERIFIED state",
      body.count('results[plan["symbol"]] = verified') == 2,
      body.count('results[plan["symbol"]] = verified'))
plan_body = body.split("def cmd_plan")[1]
check("a missing study triggers an add, not just a warning",
      "add_script_to_chart(page)" in plan_body)
# Acting on the chart is only safe when the save landed; otherwise it cannot help.
check("the add is gated on the save having landed",
      "if not plan_study_present(page) and applied:" in body)
check("a failed save says the chart was left untouched",
      "the chart was left exactly as it was" in body)
check("success is not claimed without a study on the chart",
      "verified = applied and present" in body)

print(("\n%d FAILED" % len(failures)) if failures else "\nall passed")
sys.exit(1 if failures else 0)
