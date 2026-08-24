"""
TradingView Bot — JARVIS automation
Login, draw daily plan levels, set price alerts, generate Pine Script

Usage:
  python tradingview_bot.py plan                          # AUTO: live signals -> all 3 charts
  python tradingview_bot.py plan GOLD                     # AUTO: one symbol
  python tradingview_bot.py test                          # test login
  python tradingview_bot.py draw BTC 105000 103500 107000 104000 106500
  python tradingview_bot.py alert BTC 107000 "Resistance — watch for rejection"
  python tradingview_bot.py pine BTC 105000 103500 107000 104000 106500

`plan` is the one to use. It reads /api/signals and /api/strategy-settings itself,
so the chart cannot drift from the engine, and it reloads each chart before applying
so re-running replaces the plan instead of stacking another copy of it.

Needs Edge on CDP 9222: tasks\\launch_chrome_tv.bat
"""

import sys, os, time, json, urllib.request
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:
    print("ERROR: playwright not installed.")
    print("Run:  pip install playwright")
    print("Then: playwright install chromium")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
KEYS_FILE   = Path(__file__).parent / "keys.env"
TV_BASE     = "https://www.tradingview.com"
CHROME_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SERVER_URL  = "http://localhost:3001"
SHOT_DIR    = Path(__file__).parent / "dashboard" / "screenshots"

# Gold is charted as XAUUSD, not TVC:GOLD. The broker feed is XAUUSD and TV prices
# it within a few cents of our signal; TVC:GOLD is a different basis and has already
# cost us once by showing levels that did not exist on the bars we actually trade.
CHART_SYMBOLS = {
    "BTC":    "BINANCE:BTCUSDT",
    "GOLD":   "OANDA:XAUUSD",
    "SPX":    "SP:SPX",
    "BTCUSD": "BINANCE:BTCUSDT",
    "XAUUSD": "OANDA:XAUUSD",
    "SP500":  "SP:SPX",
    "SPY":    "SP:SPX",
}

# The asset keys as /api/signals returns them.
API_ASSETS = {"BTC": "btc", "GOLD": "gold", "SPX": "spx"}

# Live selectors, verified against TradingView 2026-08-07. The originals
# (pine-editor-activate-button, .cm-content, header-user-menu-button) are all dead:
# the editor is Monaco now and a signed-in session has no "Add to chart" button,
# so the script is applied with Ctrl+Enter.
SEL_PINE_BUTTON = '[data-name="pine-dialog-button"]'
SEL_MONACO      = '.monaco-editor'
SEL_EDITOR_TEXT = '.monaco-editor .view-lines'
SEL_USER_MENU   = '[class*="userMenu"], button[aria-label*="Open user menu" i]'
SEL_SIGN_IN     = '[data-name="header-user-menu-sign-in"], button:has-text("Sign in")'
# "Update on chart" is the apply control in the current editor — Ctrl+Enter does
# NOT apply, it only looked like it did because the old check tested for compile
# errors instead of testing whether the study reached the chart.
SEL_APPLY       = '[data-tooltip="Update on chart"], [aria-label="Update on chart"]'
SEL_COLLAPSE    = '[data-tooltip="Collapse panel"], [aria-label="Collapse panel"]'
# Exact labels only. A loose button:has-text("Save") fallback matched the
# "All changes saved" status chip first and clicking it timed out every run.
SEL_SAVE        = ('[title="Save script"], [data-tooltip="Save script"], '
                   '[aria-label="Save script"]')
# The plan lives as ONE saved script. Saving it pushes the new source into every
# chart already using it, which is how the plan updates without adding a study.
SAVED_SCRIPT_NAME = "JARVIS Daily Plan"
# Pine editor internals. Class hashes rotate with TradingView releases, so match on
# the STABLE fragment rather than the whole name; data-name attributes are stable.
SEL_PINE_DIALOG = '[data-name=pine-dialog]'
SEL_EDITOR_AREA = '[data-name=pine-dialog] [class*="monaco"]'
SEL_NAME_BUTTON = '[data-name=pine-dialog] [class*="nameButton"]'
SEL_SAVE_BUTTON = '[data-name=pine-dialog] [class*="saveButton"]'
SEL_OPEN_DIALOG = '[data-name=open-user-script-dialog]'
SEL_OPEN_ITEM   = '[data-name=open-script-dialog-item-name]'
# The dialog's own Search box. Matched by tag rather than by placeholder text, which is
# localised — the dialog holds exactly one input on this build.
SEL_OPEN_SEARCH = '[data-name=open-user-script-dialog] input'


def squash(text):
    """Compare script names through TradingView's markup.

    The open-script dialog renders every CHARACTER in its own element, so a title reads
    back as 'J\\nA\\nR\\nV\\nI\\nS\\n \\nD...' and no amount of .strip() makes it equal
    'JARVIS Daily Plan'. Monaco separately renders spaces as U+00A0. Dropping ALL
    whitespace sidesteps both without inventing a fuzzy match: two names that differ by
    anything other than whitespace still differ.
    """
    return "".join(str(text).split()).casefold()

# What the applied study actually renders on the chart is the table header, which
# reads "JARVIS PLAN - <SYMBOL>". The indicator's own name ("JARVIS Daily Plan - X")
# lives in the legend and is not reliably in the DOM text.
PLAN_TITLE_FMT  = "JARVIS PLAN - {}"

LINE_COLORS = {
    "entry":      "#4CAF50",   # green
    "stop":       "#F44336",   # red
    "target":     "#2196F3",   # blue
    "support":    "#64B5F6",   # light blue
    "resistance": "#EF9A9A",   # light red
    "key":        "#FFC107",   # amber
}

# ── Credentials ───────────────────────────────────────────────────────────────
def get_cred(key):
    if not KEYS_FILE.exists():
        return None
    for line in KEYS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None

# ── Session config ─────────────────────────────────────────────────────────────
# Derived, not hardcoded. This named one user profile path literally, so the copy
# deployed to the VPS - present, syntax-clean, looking every bit as installed as the
# laptop copy - pointed at a directory that cannot exist under its Administrator
# account. Identical value on this machine; the difference only shows on a box whose
# user account is not the one that was baked in.
_TV_PROFILE_ROOT = os.environ.get("LOCALAPPDATA") or "C:\\Users\\User\\AppData\\Local"
CHROME_USER_DATA = str(Path(_TV_PROFILE_ROOT) / "Microsoft" / "Edge" / "SmartEntryTV")
SESSION_FILE     = Path(__file__).parent / "tasks" / ".tv_session.json"

def save_session(ctx):
    """Save TV cookies to file — survives browser restarts."""
    try:
        SESSION_FILE.parent.mkdir(exist_ok=True)
        SESSION_FILE.write_text(json.dumps(ctx.storage_state()), encoding="utf-8")
        print("[TV] Session saved — no login needed next time")
    except Exception as e:
        print(f"[TV] Session save failed: {e}")

def make_context(playwright):
    """
    Attach to the already-running Edge on port 9222.
    Returns (browser, ctx) or raises if not available.
    """
    browser = playwright.chromium.connect_over_cdp("http://localhost:9222")
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    # Pine scripts are pasted, not typed, so the page needs clipboard write access.
    try:
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=TV_BASE)
    except Exception as exc:
        print(f"[TV] Clipboard permission not granted ({exc}) — paste may fail")
    print("[TV] Attached to running Edge")
    return browser, ctx

# ── Login ─────────────────────────────────────────────────────────────────────
def is_logged_in(page):
    """
    True when the session is authenticated.

    Presence of a user-menu button is NOT a usable test — TradingView renames that
    class regularly and the old data-name selector matches nothing on a signed-in
    page. Absence of the sign-in control is the marker that actually holds.
    """
    try:
        if "tradingview.com" not in page.url:
            return False
        return page.locator(SEL_SIGN_IN).count() == 0
    except Exception:
        return False


def login(page, ctx):
    """Login to TradingView only if not already logged in."""
    # Check current URL — if already on TV and logged in, skip everything
    if is_logged_in(page):
        print("[TV] Already logged in")
        return

    username = get_cred("TV_USERNAME")
    password = get_cred("TV_PASSWORD")

    page.goto(f"{TV_BASE}/")
    page.wait_for_load_state("domcontentloaded")
    time.sleep(2)

    # Already logged in?
    if is_logged_in(page):
        print("[TV] Already logged in (session active)")
        return

    # No credentials — tell user to log in manually in the open window
    if not username or not password:
        print("[TV] No credentials — please log into TradingView in the browser window.")
        print("[TV] Waiting up to 3 minutes...")
        for _ in range(60):
            if is_logged_in(page):
                save_session(ctx)
                print("[TV] Logged in — session saved.")
                return
            time.sleep(3)
        return

    # Open sign-in dialog
    try:
        page.click('[data-name="header-user-menu-sign-in"]', timeout=8000)
    except PWTimeout:
        try:
            page.click('button:has-text("Sign in")', timeout=5000)
        except:
            page.goto(f"{TV_BASE}/accounts/signin/")
    time.sleep(2)

    # Click "Email" tab inside the dialog
    for selector in ['button[name="Email"]', 'button:has-text("Email")', '[class*="emailButton"]']:
        try:
            page.click(selector, timeout=3000)
            time.sleep(0.8)
            break
        except:
            continue

    # Fill email — try multiple selectors
    email_filled = False
    for selector in ['input[name="username"]', 'input[type="email"]', 'input[autocomplete="username"]', 'input[placeholder*="mail"]']:
        try:
            page.fill(selector, username, timeout=5000)
            email_filled = True
            break
        except:
            continue
    if not email_filled:
        print("[TV] Could not find email field — browser is open, please log in manually.")
        print("[TV] Waiting up to 3 minutes...")
        page.wait_for_url(f"{TV_BASE}/**", timeout=180000)
        for _ in range(60):
            if "signin" not in page.url and "accounts" not in page.url:
                break
            time.sleep(3)
        save_session(ctx)
        print("[TV] Logged in manually — session saved.")
        return

    # Fill password
    for selector in ['input[name="password"]', 'input[type="password"]', 'input[autocomplete="current-password"]']:
        try:
            page.fill(selector, password, timeout=5000)
            break
        except:
            continue

    # Submit
    for selector in ['button[type="submit"]', 'button:has-text("Sign in")', 'button:has-text("Continue")']:
        try:
            page.click(selector, timeout=5000)
            break
        except:
            continue
    time.sleep(2)

    # Check if 2FA code is required
    needs_2fa = False
    try:
        page.wait_for_selector('input[name="code"], input[autocomplete="one-time-code"], input[placeholder*="code"]', timeout=4000)
        needs_2fa = True
    except:
        pass

    if needs_2fa:
        print("\n[TV] 2FA required — check your email/authenticator app.")
        print("[TV] Enter the code in the browser window that just opened.")
        print("[TV] Waiting up to 3 minutes for you to complete login...\n")
        # Wait up to 3 minutes for user to complete 2FA and land on TV homepage
        page.wait_for_url(f"{TV_BASE}/**", timeout=180000)
        # Make sure we're past any auth pages
        for _ in range(30):
            if "signin" not in page.url and "accounts" not in page.url:
                break
            time.sleep(2)

    time.sleep(2)
    save_session(ctx)
    print(f"[TV] Logged in: {username}")

# ── Chart navigation ──────────────────────────────────────────────────────────
def open_chart(page, symbol):
    """
    Load a symbol's chart and wait until it is actually usable.

    Never wait for "networkidle" here: TradingView holds streaming sockets open, so
    the network never goes idle and the wait can only ever time out. The Pine button
    appearing is the real readiness signal.
    """
    tv_sym = CHART_SYMBOLS.get(symbol.upper(), symbol)
    page.goto(f"{TV_BASE}/chart/?symbol={tv_sym}",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector(SEL_PINE_BUTTON, timeout=45000)
    time.sleep(5)
    print(f"[TV] Chart open: {tv_sym}")

# ── Price range from axis ─────────────────────────────────────────────────────
def read_price_range(page):
    """Read visible price range from the right-side price axis labels."""
    try:
        labels = page.locator('[class*="price-axis"] text, [class*="priceAxisLastValue"]').all()
        prices = []
        for lbl in labels:
            try:
                val = float(lbl.inner_text().replace(",", "").strip())
                prices.append(val)
            except:
                pass
        if len(prices) >= 2:
            return min(prices), max(prices)
    except:
        pass
    return None, None

def price_to_y(price, p_min, p_max, chart_top, chart_height):
    ratio = (price - p_min) / (p_max - p_min)
    return chart_top + int(chart_height * (1 - ratio))

# ── Draw horizontal line ──────────────────────────────────────────────────────
def draw_hline(page, price, label):
    """Draw a horizontal line at a specific price using TV keyboard shortcuts."""
    try:
        # Get chart canvas area
        canvas = page.locator('[class*="chart-container"], canvas').first
        box = canvas.bounding_box()
        if not box:
            print(f"[TV] Cannot find chart canvas — skipping {label}")
            return False

        p_min, p_max = read_price_range(page)
        if not p_min:
            print(f"[TV] Cannot read price range — skipping {label}")
            return False

        y = price_to_y(price, p_min, p_max, box["y"], box["height"])
        x = box["x"] + box["width"] * 0.5

        # Activate horizontal line tool (TV shortcut: Alt+H)
        page.keyboard.press("Alt+h")
        time.sleep(0.4)

        # Click at the price level
        page.mouse.click(x, y)
        time.sleep(0.5)

        # Escape to deselect
        page.keyboard.press("Escape")
        time.sleep(0.3)

        print(f"[TV] {label}: ${price:,.0f}")
        return True
    except Exception as e:
        print(f"[TV] Draw error ({label}): {e}")
        return False

# ── Set price alert ───────────────────────────────────────────────────────────
def set_alert(page, price, symbol, message):
    """Create a TradingView price alert via the alert dialog."""
    try:
        # Open alert dialog: Alt+A
        page.keyboard.press("Alt+a")
        time.sleep(1.5)

        # Set price condition
        price_input = page.locator('input[class*="priceField"], input[placeholder*="price"], input[name*="price"]').first
        price_input.clear()
        price_input.fill(str(price))
        time.sleep(0.3)

        # Set message
        try:
            msg_field = page.locator('textarea[class*="message"], input[class*="message"]').first
            msg_field.clear()
            msg_field.fill(message)
        except:
            pass

        # Submit
        page.click('button[class*="submit"], button:has-text("Create")', timeout=5000)
        time.sleep(1)
        print(f"[TV] Alert set: ${price:,.0f} — {message}")
        return True
    except Exception as e:
        print(f"[TV] Alert error: {e}")
        return False

# ── Generate Pine Script ──────────────────────────────────────────────────────
def _pine_str(value):
    """Quote a value for Pine, stripping the quotes and newlines that would break it."""
    text = "-" if value is None else str(value)
    return '"' + text.replace('\\', '').replace('"', "'").replace("\n", " ") + '"'


def _fmt(price, decimals):
    return "-" if price is None else f"{price:,.{decimals}f}"


# Substrings matched against syminfo.ticker to pick which plan a chart shows.
TICKER_TESTS = {
    "BTC":  ["BTC"],
    "GOLD": ["XAU", "GOLD"],
    "SPX":  ["SPX", "SP500", "US500"],
}

# Fixed row order, so every symbol fills the same table shape.
#
# Entry / SL / TP lead, and they are rows in their own right. They used to exist
# only as line labels out on the price scale, which made the panel useless for the
# one thing it is looked at for. The context rows below them earn their place by
# explaining the trade; everything that did not (session, volume, swing, feed,
# strength, two spare reason lines) is gone, because a cluttered panel over a
# chart that already carries ten indicators is worse than no panel.
PLAN_ROWS = ["Entry", "SL", "TP", "R:R", "Levels", "Pivots", "Confidence", "Setup",
             "Regime", "Trend D1", "Trend H4", "Trend H1", "1D read", "4H read", "Note"]

# Broker symbol per API asset, so a plan can find its own rows in the measured read.
READ_SYMBOL = {"BTC": "BTCUSD", "GOLD": "XAUUSD", "SPX": "SP500"}

# WHAT GETS A LINE ON THE CHART, AND WHAT DOES NOT.
#
# This used to be one list of seven, and every one of them was drawn whenever the
# value existed. On 2026-08-24 the Gold chart showed the result: S1, S2, R1, R2 and
# the price, five dashed and dotted lines with red and green pills, on a chart that
# ALREADY carries APEX SMC, Clean Structure PRO and TK Swing Trend each drawing
# their own levels. Meanwhile the panel in the corner said, correctly,
# "PIVOT BAND - not a trade" and "R:R  n/a - no setup".
#
# The panel was honest. The canvas was not. A red dashed line with a pill reading
# "S2 4,458.07" looks exactly like a stop loss, and the qualifier that says it is
# not one lived twelve rows away in a table the eye does not reach first. On a chart
# used to trade MANUALLY that is the expensive kind of wrong: not a false number, a
# true number dressed as an instruction.
#
# So lines are earned now. Only a real engine setup draws them, and it draws the
# three that constitute a trade. The pivot band still ships in full - as TEXT, in
# the panel, where "S1" reads as a level rather than as an order.
SETUP_LEVELS = [
    ("entry",  "color.new(color.green, 0)", 2, "line.style_solid"),
    ("stop",   "color.new(color.red, 0)",   2, "line.style_dashed"),
    ("target", "color.new(color.blue, 0)",  2, "line.style_dashed"),
]

# Context levels: carried in the panel, never drawn as lines.
CONTEXT_LEVELS = [("resistance", "R1"), ("support", "S1"),
                  ("breakout_up", "Brk+"), ("breakout_down", "Brk-")]

# A trade is a distance, not three prices, and the eye reads a shaded band faster
# than it reads two pills. Transparency is high enough that the candles and the
# user's own indicators stay legible through the fill.
ZONE_RISK_COLOUR = "color.new(color.red, 88)"
ZONE_REWARD_COLOUR = "color.new(color.green, 88)"

BIAS_COLOURS = {"LONG": "color.new(color.green, 0)",
                "SHORT": "color.new(color.red, 0)"}


def _level_label(plan, key):
    """A pivot fallback is not a trade, so it must not be labelled like one."""
    is_setup = plan.get("levels_from", "engine") == "engine"
    names = {"entry":  "Entry" if is_setup else "Price",
             "stop":   "Stop"  if is_setup else "S2",
             "target": "Target" if is_setup else "R2",
             "resistance": "R1", "support": "S1",
             "breakout_up": "Break BUY", "breakout_down": "Break SELL"}
    return names[key] + " " + _fmt(plan.get(key), plan["decimals"])


def _context_row(values):
    """The context levels as one compact line, or a plain dash when none resolved.

    Takes the caller's locals rather than the finished plan because the plan dict is
    still being built at this point. Only the four CONTEXT_LEVELS names are read.
    """
    decimals = values.get("decimals", 2)
    parts = [label + " " + _fmt(values.get(key), decimals)
             for key, label in CONTEXT_LEVELS
             if values.get(key) is not None]
    return "  ".join(parts) if parts else "-"


def _ternary(plans, value_of, default):
    """Build `_isBTC ? v1 : _isGOLD ? v2 : ... : default` for a single field."""
    chain = ["_is" + plan["symbol"] + " ? " + str(value_of(plan)) for plan in plans]
    return " : ".join(chain) + " : " + default


# ---- The applied study's version, readable WITHOUT reading the canvas --------
#
# apply_pine's comment is right that a DOM assertion cannot see the plan: Pine draws
# the table, lines and labels onto the chart CANVAS, so none of it is page text. But
# the study's LEGEND TITLE is an ordinary DOM element - list_plan_studies already
# reads it - and on 2026-08-21 a probe found it was the only "JARVIS" string on the
# entire page, carrying no version at all.
#
# So the legend title carries the stamp. That turns the one readable element into a
# statement about WHICH version is applied, which is exactly the thing that was
# unknowable: the Gold chart rendered an Aug-7 plan for fourteen days while the job
# logged "OK: plan drawn on all charts" and exited 0.
#
# The prefix is preserved so list_plan_studies keeps matching.
def plan_legend_name(generated_at):
    return SAVED_SCRIPT_NAME + " " + plan_stamp(generated_at)


def plan_stamp(generated_at):
    """MM-DD HH:MM from a '%Y-%m-%d %H:%M' timestamp. The year is dropped for legend
    width; a 12-month-stale plan is not the failure mode this guards."""
    return generated_at[5:]


def plan_study_present(page):
    """
    Is a plan study on the chart at all? That is the whole of what the DOM can say.

    Replaces applied_plan_stamp(), which tried to read the plan's VERSION back off
    the legend via indicator(shorttitle=...). The legend shows the SAVED SCRIPT NAME
    for a study added from a saved user script, so the stamp never appeared there and
    the check could never have passed. The chart answers the version question itself,
    with the STALE marker Pine renders from its own embedded timestamp.
    """
    return bool(list_plan_studies(page))


def generate_pine(plans):
    """
    Build ONE daily-plan indicator covering every symbol.

    This has to be a single script rather than one per symbol. All three charts
    live in the same saved TradingView layout, and a layout holds one chart state,
    so a per-symbol study applied in one tab propagated to the others and the last
    one won — the Gold chart ended up rendering BTC's plan, levels and all.
    Selecting on syminfo.ticker works with that model instead of against it: apply
    once, correct on whichever symbol the chart is showing, and a second copy of
    the plan becomes impossible to create.
    """
    if isinstance(plans, dict):          # single plan, from cmd_pine
        plans = [plans]

    flags = []
    for plan in plans:
        tests = TICKER_TESTS.get(plan["symbol"], [plan["symbol"]])
        checks = " or ".join('str.contains(_sym, "%s")' % t for t in tests)
        flags.append("_is" + plan["symbol"] + " = " + checks)

    # A level is a candidate only when some plan on this script HAS it and that plan
    # is a real engine setup. A chart in WAIT gets no price lines at all.
    live_keys = [spec for spec in SETUP_LEVELS
                 if any(plan.get(spec[0]) is not None
                        and plan.get("levels_from", "engine") == "engine"
                        for plan in plans)]

    # The job runs 06:45 and 13:15, so the longest NORMAL age is the overnight
    # 13:15 -> 06:45 gap of 17.5h. A threshold just above that fires only when a run
    # was actually missed, never on a healthy schedule.
    STALE_AFTER_HOURS = 18.0
    plan_ts_ms = plans[0].get("generated_ts_ms")
    if plan_ts_ms is None:
        # Never guess an age. An unknown age must read as unknown, not as fresh.
        stale_vars = [
            "_planAgeSuffix = \"  (age unknown)\"",
            "_planAgeColor = color.gray",
        ]
    else:
        stale_vars = [
            "_planTs = %d" % int(plan_ts_ms),
            "_planAgeHrs = (timenow - _planTs) / 3600000.0",
            "_planStale = _planAgeHrs > %.1f" % STALE_AFTER_HOURS,
            '_planAgeSuffix = _planStale ? "  STALE " + str.tostring(_planAgeHrs, "#.#") + "h" : ""',
            "_planAgeColor = _planStale ? color.red : color.white",
        ]

    level_vars, draw_block = [], []
    level_vars.extend(stale_vars)

    # One flag per script saying whether THIS chart's symbol has a real setup.
    # Without it, a script covering three assets would draw BTC's entry on the Gold
    # chart, because the ternary would fall through to a value that exists.
    level_vars.append("_isSetup = " + _ternary(
        plans,
        lambda p: "true" if p.get("levels_from", "engine") == "engine" else "false",
        "false"))

    for key, colour, width, style in live_keys:
        level_vars.append("_" + key + " = " + _ternary(
            plans, lambda p, k=key: p.get(k) if p.get(k) is not None else "na", "na"))
        level_vars.append("_" + key + "Txt = " + _ternary(
            plans, lambda p, k=key: _pine_str(_level_label(p, k)), '""'))
        draw_block.append(
            "    if _isSetup and not na(_%s)\n"
            "        line.new(bar_index - 120, _%s, bar_index + 20, _%s, "
            "extend=extend.right, color=%s, width=%d, style=%s)\n"
            "        label.new(bar_index + 20, _%s, _%sTxt, color=%s, "
            "textcolor=color.white, style=label.style_label_left, size=size.small)"
            % (key, key, key, colour, width, style, key, key, colour)
        )

    # The two zones that turn three prices into a trade: entry->stop is what is
    # risked, entry->target is what is sought. Drawn only when all three levels
    # exist, so a partial plan cannot shade a band it has no second edge for.
    drawn_keys = {spec[0] for spec in live_keys}
    if {"entry", "stop", "target"} <= drawn_keys:
        draw_block.append(
            "    if _isSetup and not na(_entry) and not na(_stop)\n"
            "        box.new(bar_index - 120, math.max(_entry, _stop), "
            "bar_index + 20, math.min(_entry, _stop), "
            "border_color=color.new(color.red, 70), bgcolor=" + ZONE_RISK_COLOUR
            + ", extend=extend.right)")
        draw_block.append(
            "    if _isSetup and not na(_entry) and not na(_target)\n"
            "        box.new(bar_index - 120, math.max(_entry, _target), "
            "bar_index + 20, math.min(_entry, _target), "
            "border_color=color.new(color.green, 70), bgcolor=" + ZONE_REWARD_COLOUR
            + ", extend=extend.right)")

    cells = [
        # The ternary MUST be parenthesised. Pine binds + tighter than ?: , so
        # `_isGOLD ? "a" : "b" + _suffix` attaches the suffix to the FALLBACK branch
        # only - the stale marker would never appear on a real symbol.
        "    table.cell(planTable, 0, 0, (" + _ternary(
            plans,
            # [-5:] was HH:MM with the date discarded, so a plan drawn two days ago
            # read exactly like one drawn this morning. That is the stale-chart failure
            # this whole job exists to prevent, printed in the header.
            lambda p: _pine_str("JARVIS " + p["symbol"] + "  " + p["generated_at"][5:]),
            '"JARVIS PLAN"')
        + ") + _planAgeSuffix, text_color=_planAgeColor, text_size=size.normal, text_halign=text.align_left)",
        "    table.cell(planTable, 1, 0, " + _ternary(
            plans, lambda p: _pine_str(p.get("bias") or "WAIT"), '"-"')
        + ", text_color=color.white, text_size=size.normal, text_halign=text.align_left"
        + ", bgcolor=" + _ternary(
            plans,
            lambda p: BIAS_COLOURS.get(p.get("bias"), "color.new(color.gray, 0)"),
            "color.new(color.gray, 0)") + ")",
    ]
    for i, key in enumerate(PLAN_ROWS):
        cells.append(
            "    table.cell(planTable, 0, %d, %s, text_color=color.gray, "
            "text_size=size.small, text_halign=text.align_left)" % (i + 1, _pine_str(key))
        )
        cells.append(
            "    table.cell(planTable, 1, %d, %s, text_color=color.white, "
            "text_size=size.small, text_halign=text.align_left)"
            % (i + 1, _ternary(plans,
                               lambda p, k=key: _pine_str(p["rows"].get(k, "-")), '"-"'))
        )

    newline = chr(10)
    return """//@version=5
indicator("JARVIS Daily Plan", shorttitle="%s", overlay=true, max_lines_count=40, max_labels_count=40)

// Generated by JARVIS - %s
// Covers: %s
// Levels come from the SmartEntry engine, not from this chart's own feed.

_sym = syminfo.ticker
%s
_known = %s

%s

var table planTable = table.new(position.top_right, 2, %d,
     border_width=1, frame_width=1, frame_color=color.new(color.gray, 40),
     bgcolor=color.new(color.black, 15))

if barstate.islast and _known
%s

%s
""" % (
        plan_legend_name(plans[0]["generated_at"]),
        plans[0]["generated_at"],
        ", ".join(p["symbol"] for p in plans),
        newline.join(flags),
        " or ".join("_is" + p["symbol"] for p in plans),
        newline.join(level_vars),
        len(PLAN_ROWS) + 1,
        newline.join(cells),
        newline.join(draw_block),
    )

# ── Pine Editor auto-paste ────────────────────────────────────────────────────
def _editor_text(page):
    """
    Read what is in the Pine editor, in VISUAL line order.

    Three traps, and the third one wasted two hours on 2026-08-24.

    Monaco renders every space as U+00A0, so normalise before comparing.

    .view-lines is virtualised: it holds only the lines currently scrolled into view,
    so after a paste it shows the END of the script and a check against line 1 fails
    on a script that landed perfectly. The caller must scroll to the top first.

    AND - the part that was wrong - Monaco does NOT keep those elements in document
    order. It recycles a pool of divs and positions each by an inline `top`, so DOM
    order is arbitrary. inner_text() therefore returned the visible lines SHUFFLED,
    and the "does it start with //@version=5" check was reading whichever line the
    pool happened to hold first. It passed for months by luck and started failing the
    moment the script grew by four lines and the pool reshuffled.

    The evidence was unambiguous once looked at directly: the editor reported unsaved
    changes, the buffer contained today's Gold price and our own "(S2 pivot)" text,
    scrollTop was 0 - and the "first line" came back as a table.cell from the middle.
    Nothing was wrong with the paste. The reader was lying.

    So read each .view-line with its own top offset and sort numerically.
    """
    lines = page.evaluate("""(sel) => {
        const box = document.querySelector(sel);
        if (!box) return null;
        return Array.from(box.querySelectorAll('.view-line'))
            .map(el => [parseFloat(el.style.top) || 0, el.textContent])
            .sort((a, b) => a[0] - b[0])
            .map(pair => pair[1]);
    }""", SEL_EDITOR_TEXT)
    if lines is None:
        # Selector missed entirely - fall back rather than crash, and let the
        # caller's own check decide. An empty read reads as "did not land", which
        # is the safe direction: it refuses to save, it never saves the wrong thing.
        return page.locator(SEL_EDITOR_TEXT).first.inner_text().replace("\xa0", " ")
    return "\n".join(lines).replace("\xa0", " ")


def _scroll_editor_top(page):
    """Bring line 1 into Monaco's rendered window. Returns True when it got there.

    One Ctrl+Home and a fixed 800ms was enough until the plan script grew by a few
    lines on 2026-08-24, and then it stopped being enough: the paste landed perfectly,
    the view stayed parked mid-document, and the caller read
    `table.cell(planTable, 0, 1, "Entry"...)` as "the script starts with" and refused
    to save a script that was already correct. Twice in a row, reproducibly.

    .view-lines holds ONLY what is scrolled into view, so this is a question about the
    viewport, not about the buffer. Poll it instead of guessing a duration.
    """
    for attempt in range(4):
        page.keyboard.press("Control+Home")
        page.wait_for_timeout(600 + 400 * attempt)
        try:
            if _editor_text(page).lstrip().startswith("//@version=5"):
                return True
        except Exception:
            pass
    return False


PLAN_NAME_PREFIX = "JARVIS Daily Plan"


def list_plan_studies(page):
    """
    Titles of the JARVIS plan studies attached to the layout.

    Reads the legend rows directly. They keep their text in the DOM even when the
    legend is collapsed to its counter — which it is on this layout, and which is
    why every attempt to hover or click them failed with "element is not visible".
    Counting still works, so study growth stays detectable even where removal
    through the UI does not.
    """
    try:
        return [t.strip() for t in page.locator(".title-quatTGAC").all_inner_texts()
                if t.strip().startswith(PLAN_NAME_PREFIX)]
    except Exception:
        return []


def ensure_legend_expanded(page):
    """Expand the collapsed legend so studies become clickable. IDEMPOTENT.

    The counter is a TOGGLE: clicking it when the legend is already open CLOSES it, and
    the first attempt at this expanded the legend and then immediately collapsed the one
    it had just opened. So the state is checked before the click, never after.

    Click the counter's LEFT EDGE. The box measures ~1243px wide and its centre is empty
    chart, where the canvas swallows the event — which is why element clicks and
    JS-dispatched clicks both failed here for weeks. Coordinates, via page.mouse.

    HONEST STATUS 2026-08-24: this works but is NOT reliable. The identical click at
    (72,61) expanded the legend to 210 visible rows on one attempt and did nothing on the
    next, with no state change in between. Treat a False return as normal and fall back
    to telling the human exactly which study to delete — see report_orphan_studies.
    """
    rows = page.locator(".title-quatTGAC")
    if rows.count() and rows.first.is_visible():
        return True
    box = page.evaluate("""() => {
      const c=[...document.querySelectorAll('[class*="legend-"]')].map(e=>{
        const r=e.getBoundingClientRect();
        return {x:r.x,y:r.y,w:r.width,h:r.height,vis:e.offsetParent!==null};
      }).filter(o=>o.vis && o.w>500 && o.h>10 && o.h<80);
      return c.length ? c[0] : null;
    }""")
    if not box:
        return False
    page.mouse.click(int(box["x"]) + 12, int(box["y"]) + int(box["h"] / 2))
    page.wait_for_timeout(2500)
    rows = page.locator(".title-quatTGAC")
    return bool(rows.count() and rows.first.is_visible())


def report_orphan_studies(page):
    """Name the stale plan studies, because stacking is invisible until it is explained.

    A plan study whose title carries a TIMESTAMP is an orphan: it was added out of an
    unsaved editor and is backed by no saved script, so no amount of saving can ever
    update it. The bound study is the one titled exactly SAVED_SCRIPT_NAME.

    This is what was actually wrong on 2026-08-24. The chart carried BOTH
    'JARVIS Daily Plan' (bound, updating correctly) and 'JARVIS Daily Plan 08-24 06:45'
    (orphan, drawing the old panel on top). The earlier reading of that — "the study is
    pinned to the script version it was added at" — was WRONG, and the fix is not a
    version problem: it is one stale study that has to go.
    """
    titles = list_plan_studies(page)
    orphans = [t for t in titles if t != SAVED_SCRIPT_NAME]
    if orphans:
        print(f"[TV] {len(orphans)} ORPHAN plan study(ies) on this chart: {orphans}")
        print("[TV] These are backed by no saved script, so saving can never update them,")
        print("[TV] and they draw the OLD panel over the live one. Delete them by hand:")
        print("[TV]   click the legend counter (top-left of the chart) to expand it,")
        print(f"[TV]   hover the row titled {orphans[0]!r} and click its Remove (x).")
        print(f"[TV] Keep the one titled exactly {SAVED_SCRIPT_NAME!r} — that is the live one.")
    return orphans


def remove_plan_studies(page, limit=12):
    """
    Delete every JARVIS plan study from the layout.

    Necessary because a saved TradingView layout autosaves its studies: they
    survive navigation, so re-running stacked a new copy each time instead of
    replacing. Worse, the earlier per-symbol scripts carried no symbol guard and
    drew their table on every chart in the layout, which is how BTC's plan ended
    up covering the Gold chart.

    The title guard is strict on purpose. This layout also holds the user's own
    work — APEX SMC, Clean Structure PRO, TK Swing Trend Pullback and others — and
    nothing without the JARVIS prefix may ever be touched.
    """
    # When the legend is collapsed its rows are zero-size, so nothing can be hovered
    # or clicked and every removal attempt just burns its timeout. Detect that and
    # say so, rather than failing slowly on each run.
    # Try to expand first. It is unreliable (see ensure_legend_expanded), so a
    # failure here is normal and must not read as an error.
    if not ensure_legend_expanded(page):
        print("[TV] Legend is collapsed and would not expand — studies cannot be removed "
              "programmatically on this run.")
        report_orphan_studies(page)
        return []

    removed = []
    for _ in range(limit):
        titles = list_plan_studies(page)
        if not titles:
            break
        title = titles[0]
        if not title.startswith(PLAN_NAME_PREFIX):
            break                 # belt and braces: never touch a foreign study
        try:
            row = page.locator(f'text="{title}"').first
            row.hover(timeout=8000)
            page.wait_for_timeout(600)
            row.locator('xpath=ancestor::*[.//*[@aria-label="Remove"]][1]') \
               .locator('[aria-label="Remove"]').first.click(timeout=8000)
            page.wait_for_timeout(1800)
            removed.append(title)
        except Exception as exc:
            print(f"[TV] could not remove {title!r}: {exc}")
            break
    if removed:
        print(f"[TV] Removed {len(removed)} stale plan study(ies): {removed}")
    return removed


def paste_pine(page, pine, label):
    """
    Open the Pine editor and put `pine` in it. Returns True when the source landed.

    Shared by both paths: applying the script as a new study, and saving it so that
    every chart already using it picks the change up.
    """
    page.bring_to_front()
    page.wait_for_selector(SEL_PINE_BUTTON, timeout=45000)
    page.wait_for_timeout(3000)
    # Was a bare click on the Pine toggle. That button CLOSES the editor when it is
    # already open, and with the editor open it is not reliably clickable at all - a
    # 30s timeout that surfaced as "Cannot connect to Edge". It only ever worked
    # because the editor happened to start closed.
    if not ensure_editor_open(page):
        return False

    # Monaco tears down and rebuilds while booting, so wait for the rendered lines
    # rather than the container, and let it settle before touching it.
    page.wait_for_selector(SEL_EDITOR_TEXT, timeout=30000)
    page.wait_for_timeout(4000)

    for attempt in range(3):
        try:
            page.locator(SEL_EDITOR_TEXT).first.click(timeout=8000)
            break
        except Exception:
            if attempt == 2:
                raise
            page.wait_for_timeout(2500)

    # Paste, never type. keyboard.type pushes every character through CDP as its
    # own event: Monaco's auto-indent mangled the first line ("/  /@version=5") and
    # ~2500 keystrokes was enough to drop the driver connection outright. One
    # clipboard write plus Ctrl+V is a single event and cannot be half-applied.
    for _ in range(2):
        page.wait_for_timeout(1500)
        page.evaluate("text => navigator.clipboard.writeText(text)", pine)
        page.keyboard.press("Control+a")
        page.wait_for_timeout(300)
        page.keyboard.press("Control+v")
        page.wait_for_timeout(2000)
        _scroll_editor_top(page)
        if _editor_text(page).lstrip().startswith("//@version=5"):
            break

    landed = _editor_text(page).lstrip()
    if not landed.startswith("//@version=5"):
        print(f"[TV] {label}: script did not land cleanly; editor starts {landed[:60]!r}")
        return False
    return True


def editor_script_name(page):
    """What the editor header says it is editing. 'Untitled script' means UNBOUND."""
    try:
        return page.locator(SEL_NAME_BUTTON).first.inner_text(timeout=5000).strip()
    except Exception:
        return ""


def editor_has_unsaved_changes(page):
    """The save button carries an 'unsaved-' class while the buffer is dirty."""
    try:
        cls = page.locator(SEL_SAVE_BUTTON).first.get_attribute("class", timeout=5000) or ""
        return "unsaved" in cls
    except Exception:
        return False


def close_any_open_dialog(page):
    """A dialog left open traps focus and every later click is 'intercepted'."""
    for _ in range(3):
        if page.locator(SEL_OPEN_DIALOG).count() == 0:
            return
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)


def ensure_editor_open(page):
    """
    Open the Pine editor if it is not already open, and NEVER click the toggle when
    it is - that button closes it again. open_saved_script runs before paste_pine,
    which is what used to do the opening, so without this the first click inside the
    editor times out and the whole bind step is skipped.
    """
    if page.locator(SEL_PINE_DIALOG).count() > 0:
        return True
    try:
        page.click(SEL_PINE_BUTTON, timeout=8000)
        page.wait_for_selector(SEL_EDITOR_TEXT, timeout=30000)
        page.wait_for_timeout(3000)
        return True
    except Exception as exc:
        print(f"[TV] Could not open the Pine editor ({str(exc)[:70]})")
        return False


def open_saved_script(page, name=SAVED_SCRIPT_NAME):
    """
    Bind the editor to the SAVED script of this name. Returns True when bound.

    Without this the editor sits on 'Untitled script', so Save opens the
    "New script name" dialog and creates ANOTHER script instead of updating the one
    the chart uses. On 2026-08-21 the saved-script list held 11 scripts and none of
    them was the plan: the study on the chart was an orphan snapshot, added from an
    unsaved editor and backed by nothing, which is why fourteen days of saving could
    never reach it.
    """
    if not ensure_editor_open(page):
        return False
    close_any_open_dialog(page)
    if editor_script_name(page) == name:
        return True
    try:
        page.click(SEL_EDITOR_AREA, timeout=8000)
        page.wait_for_timeout(600)
        page.keyboard.press("Control+o")
        page.wait_for_selector(SEL_OPEN_DIALOG, timeout=15000)
        page.wait_for_timeout(1500)
    except Exception as exc:
        print(f"[TV] Could not open the script list ({str(exc)[:70]})")
        close_any_open_dialog(page)
        return False

    try:
        # SEARCH, never scan the rendered rows. Two independent reasons, both measured
        # against the live dialog on 2026-08-24, and either alone was fatal:
        #
        #   1. THE LIST IS VIRTUALISED. The scroll container measured scrollHeight 2866
        #      against clientHeight 467, so all_inner_texts() returned only the ~11 rows
        #      that happened to be rendered. A script further down the list simply was
        #      not there to be found, and the code reported it "not a saved script yet".
        #   2. EVERY CHARACTER IS ITS OWN ELEMENT. The title comes back as
        #      'J\nA\nR\nV\nI\nS\n \nD\na\ni\nl\ny\n \nP\nl\na\nn' — TradingView renders
        #      per-character spans, so all_inner_texts() joins them with newlines and
        #      `t.strip() == name` can NEVER be true, even for a row in full view.
        #
        # That pair is the whole reason fourteen days of saving never reached the chart:
        # every run concluded the script did not exist, took the create path, and made
        # another orphan. Typing the name into the dialog's own Search box makes the
        # server do the matching, and squash() makes the comparison survive the markup.
        searched = False
        try:
            box = page.locator(SEL_OPEN_SEARCH).first
            if box.count() > 0:
                box.fill(name)
                page.wait_for_timeout(1800)
                searched = True
        except Exception:
            pass  # older build with no search field: fall back to the rendered rows

        titles = page.locator(SEL_OPEN_ITEM).all_inner_texts()
        match = next((i for i, t in enumerate(titles) if squash(t) == squash(name)), None)
        if match is None:
            where = "no match in the dialog's search" if searched else \
                    f"{len(titles)} rendered rows scanned, and this build has no search box"
            print(f"[TV] {name!r} is not a saved script yet ({where}) "
                  f"- it will be created on this run.")
            close_any_open_dialog(page)
            return False
        page.locator(SEL_OPEN_ITEM).nth(match).click(timeout=8000)
        page.wait_for_timeout(3500)
    except Exception as exc:
        print(f"[TV] Could not open {name!r} ({str(exc)[:70]})")
        close_any_open_dialog(page)
        return False

    bound = editor_script_name(page) == name
    if not bound:
        print(f"[TV] Editor still reads {editor_script_name(page)!r} after opening {name!r}")
    return bound


def add_script_to_chart(page):
    """
    Put the CURRENTLY OPEN script on the chart as a study.

    Saving a script does not place it on a chart - it only updates charts already
    using it. So a chart that never had the study, or had its orphan snapshot
    removed, needs this once.

    SEL_APPLY matches "Update on chart", which is the label when a study from this
    script is already applied. When none is, the button reads "Add to chart" and
    carries no tooltip or aria-label at all, so the tooltip selector misses it
    entirely - matched on visible text here, scoped to the editor.
    """
    for selector in (SEL_APPLY,
                     SEL_PINE_DIALOG + ' button:has-text("Add to chart")',
                     SEL_PINE_DIALOG + ' button:has-text("Update on chart")'):
        try:
            page.click(selector, timeout=6000)
            page.wait_for_timeout(6000)
            return True
        except Exception:
            continue
    print("[TV] Could not find the add-to-chart control")
    return False


def click_save(page):
    """
    Press Save. SEL_SAVE matches title/tooltip/aria-label and the current editor's
    Save button carries NONE of them - only class 'saveButton-<hash>' and the text -
    so that selector times out every run on this build.
    """
    for selector in (SEL_SAVE_BUTTON, SEL_SAVE,
                     SEL_PINE_DIALOG + ' button:has-text("Save")'):
        try:
            page.click(selector, timeout=6000)
            return True
        except Exception:
            continue
    try:
        page.keyboard.press("Control+s")
        return True
    except Exception:
        return False


def save_as_new_script(page, name=SAVED_SCRIPT_NAME):
    """First run only: the Save dialog asks for a name because nothing is bound."""
    # The name field carries NO type attribute, so input[type=text] never matched it
    # and this timed out every run. It is the only visible <input> on the page - the
    # Monaco buffer is a <textarea> - and it comes pre-filled with the script name.
    #
    # Submit with Enter rather than clicking Save: the dialog's Save button and the
    # editor's own Save button both match button:has-text("Save"), and picking the
    # wrong one reopens this dialog instead of closing it.
    try:
        page.wait_for_selector('input:visible', timeout=8000)
        box = page.locator('input:visible').first
        box.fill(name)
        page.wait_for_timeout(500)
        box.press("Enter")
        page.wait_for_timeout(5000)
        return True
    except Exception as exc:
        print(f"[TV] Save-as dialog failed ({str(exc)[:70]})")
        page.keyboard.press("Escape")
        return False


def save_pine(page, pine, name=SAVED_SCRIPT_NAME):
    """
    Update the plan by SAVING the named script, not by adding it to the chart.

    "Update on chart" still creates another study on some runs - two consecutive
    runs measured 4 then 5 - and the layout's collapsed legend makes the extras
    unremovable from here. Saving a named script instead pushes the new source into
    every chart already using it, so the plan refreshes in place and the study count
    never moves.

    That design was right and had never once worked, because nothing bound the
    editor to the script. It sat on "Untitled script", so Save opened the "New
    script name" dialog and made ANOTHER script. On 2026-08-21 the saved list held
    11 scripts and no plan among them, while the chart carried a "JARVIS Daily Plan"
    study that was an orphan snapshot from Aug 7 - added out of an unsaved editor,
    backed by nothing, and therefore unreachable by any save.
    """
    bound = open_saved_script(page, name)

    if not paste_pine(page, pine, name):
        return False

    if bound:
        # Ctrl+S on a bound script saves in place with no dialog.
        page.keyboard.press("Control+s")
        page.wait_for_timeout(4000)
        if editor_has_unsaved_changes(page):
            print(f"[TV] {name!r} still shows unsaved changes after Ctrl+S")
            return False
        how = "bound script updated in place"
    else:
        if not click_save(page):
            print("[TV] Save control not found")
            return False
        page.wait_for_timeout(2500)
        if not save_as_new_script(page, name):
            return False
        if editor_script_name(page) != name:
            print(f"[TV] Editor reads {editor_script_name(page)!r} after save-as {name!r}")
            return False
        how = "CREATED - add it to the chart once, then every run updates it"

    # Saving cleanly is not compiling cleanly. A script with a Pine error saves
    # perfectly well and then renders nothing, which looks exactly like success.
    errors = [e.strip() for e in
              page.locator('[class*="errorMessage"], .tv-script-console__error')
                  .all_inner_texts()
              if e.strip() and "opened" not in e.lower()]
    if errors:
        print(f"[TV] Pine reported {errors[:2]}")
        return False

    print(f"[TV] Saved {name!r} ({how})")
    return True



def apply_pine(page, pine, symbol):
    """Add the script to the chart as a study. Prefer save_pine — this one stacks."""
    if not paste_pine(page, pine, symbol):
        return False

    try:
        page.click(SEL_APPLY, timeout=10000)
    except Exception:
        page.keyboard.press("Control+Enter")  # fallback for older editor builds
    page.wait_for_timeout(7000)

    errors = [e.strip() for e in
              page.locator('[class*="errorMessage"], .tv-script-console__error')
                  .all_inner_texts()
              if e.strip() and "opened" not in e.lower()]
    if errors:
        print(f"[TV] {symbol}: Pine reported {errors[:2]}")
        return False

    # Collapse the editor: the chart has to be visible both to be useful and to be
    # verifiable, since a expanded editor hides the legend entirely.
    try:
        page.click(SEL_COLLAPSE, force=True, timeout=8000)
        page.wait_for_timeout(3500)
    except Exception as exc:
        print(f"[TV] {symbol}: could not collapse the editor ({exc})")

    # There is deliberately no DOM assertion that the study rendered. Pine draws
    # tables, lines and labels onto the chart CANVAS, so none of it exists as page
    # text or elements — every innerText/legend check tried here returned empty on
    # charts that were in fact drawing the plan correctly. What is checkable is:
    # the script landed in the editor, the apply control was clicked, and the Pine
    # compiler reported no errors. The screenshot is the visual record.
    print(f"[TV] {symbol}: daily plan applied (see {SHOT_DIR / f'plan_{symbol.lower()}.png'})")
    return True


def draw_via_pine_editor(page, symbol, levels):
    """Back-compat shim for cmd_draw: build a minimal plan from (price, label) pairs."""
    picked = {label: price for price, label in levels}
    plan = build_plan(symbol, {}, gate=None, overrides={
        "entry":      picked.get("Entry"),
        "stop":       picked.get("Stop"),
        "target":     picked.get("Target"),
        "support":    picked.get("Support"),
        "resistance": picked.get("Resistance"),
    })
    return apply_pine(page, generate_pine(plan), symbol)


# ── Plan data ─────────────────────────────────────────────────────────────────
def _get_json(path):
    """GET a SmartEntry endpoint. Returns None rather than raising — a dead server
    must not look like an empty plan."""
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=6) as response:
            if response.status != 200:
                print(f"[TV] {path} returned HTTP {response.status}")
                return None
            return json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        print(f"[TV] {path} unreachable: {exc}")
        return None


def fetch_live_gate():
    """The confidence gate actually in force. Never hardcode it — it moved 65 -> 70."""
    settings = _get_json("/api/strategy-settings")
    if not settings:
        return None, "strategy-settings unreachable"
    if settings.get("settingsError"):
        return settings.get("confidenceThreshold"), \
            f"DEFAULTS IN FORCE ({settings['settingsError']})"
    return settings.get("confidenceThreshold"), "saved config"


def _decimals_for(price):
    if price is None:
        return 2
    return 2 if price >= 100 else 4


def load_candle_reads():
    """The measured next-candle read, written by tasks/candle_probability.cjs.

    Returns {} when absent or unreadable — the chart then prints "not generated" for
    those rows rather than a blank, because an absent measurement and a measurement
    showing no edge are different facts and must not look the same on a chart that is
    read before trading.
    """
    try:
        # Path(__file__).parent, not a ROOT constant — this file has never defined one,
        # and py_compile cannot see a NameError, so it would have failed at run time.
        path = Path(__file__).parent / "tasks" / "analysis" / "candle-today.json"
        if not path.exists():
            return {}
        raw = json.loads(path.read_text(encoding="utf-8"))
        out = {}
        for r in raw.get("reads", []):
            out.setdefault(r.get("symbol"), {})[r.get("tf")] = r
        return out
    except Exception as exc:
        print(f"[TV] candle read unreadable ({str(exc)[:70]}) - rows will say so")
        return {}


def _read_row(reads, symbol, tf):
    """One panel row. Says INSIDE NOISE in those words when the cell does not clear
    its own noise bar, which is the answer on most days."""
    cell = (reads.get(READ_SYMBOL.get(symbol, ""), {}) or {}).get(tf)
    if not cell:
        return "not generated - run candle_probability.cjs"
    if cell.get("error"):
        return str(cell["error"])[:60]
    pct = cell.get("cellUpPct")
    if pct is None:
        return f'{cell.get("state","?")} - too few cases to judge'
    if cell.get("actionable"):
        thin = " THIN" if cell.get("thinFolds") else ""
        return (f'{cell.get("state")} -> {pct}% up  READ{thin} '
                f'({cell.get("foldsAgreeing")}/{cell.get("foldsJudged")} folds)')
    return f'{cell.get("state")} -> {pct}% up  INSIDE NOISE (bar {cell.get("noiseBarPP")}pp)'


def build_plan(symbol, asset, gate=None, overrides=None, reads=None):
    """
    Turn one asset block from /api/signals into everything the chart should show.

    A WAIT asset still gets a plan: whatever levels the engine did compute, else
    the pivots, plus the analysis that explains why it is not firing. That is the
    point of a daily plan — knowing what would have to happen, not just what fired.
    """
    overrides = overrides or {}
    indicators = asset.get("indicators") or {}
    pivots     = asset.get("pivots") or {}
    h4         = asset.get("h4") or {}
    h1         = asset.get("h1") or {}

    price    = asset.get("price")
    decimals = _decimals_for(price)

    entry  = overrides.get("entry",  asset.get("entry"))
    stop   = overrides.get("stop",   asset.get("stop"))
    target = overrides.get("target", asset.get("target"))

    # No engine stop/target on a WAIT asset — fall back to the pivots either side.
    support    = overrides.get("support",    pivots.get("s1"))
    resistance = overrides.get("resistance", pivots.get("r1"))
    levels_from = "engine"
    if stop is None and target is None:
        stop, target = pivots.get("s2"), pivots.get("r2")
        levels_from = "pivots"

    confidence = asset.get("confidence")
    gap = None
    if gate is not None and confidence is not None:
        gap = max(0, gate - confidence)

    # R:R from the prices on the chart, never from the stored rr field — that has
    # described a different trade than the levels beside it before now. Only a real
    # engine setup has an R:R at all; a pivot band is not a trade, and printing a
    # ratio for one on the chart would invent a setup that does not exist.
    rr = None
    if levels_from == "engine" and None not in (entry, stop, target):
        risk = abs(entry - stop)
        if risk > 0:
            rr = round(abs(target - entry) / risk, 2)

    signal = asset.get("signal") or "WAIT"
    bias = signal if signal in ("BUY", "SELL") else "WAIT"
    bias = {"BUY": "LONG", "SELL": "SHORT"}.get(bias, "WAIT")

    reasons = (asset.get("reasons") or [])
    is_setup = levels_from == "engine"
    rows = {
        # The pivot fallback is not a trade, so its prices must not be dressed up
        # as one. They are shown, but named for what they are.
        "Entry":      _fmt(entry, decimals) + ("" if is_setup else "  (price)"),
        "SL":         _fmt(stop, decimals) + ("" if is_setup else "  (S2 pivot)"),
        "TP":         _fmt(target, decimals) + ("" if is_setup else "  (R2 pivot)"),
        "R:R":        f'{rr}' if rr else "n/a - no setup",
        "Levels":     "engine setup" if is_setup else "PIVOT BAND - not a trade",
        # The four context levels used to be four more lines on the chart. They are
        # real and worth knowing, so they are kept in full - as one row of text, where
        # a level reads as a level. See CONTEXT_LEVELS.
        # Filled in at the end of this function, once the breakout pair (attached
        # after this dict is built) is known. A placeholder here would ship if that
        # refresh ever stopped running, so it says so rather than showing a stale "-".
        "Pivots":     "(not computed)",
        "Confidence": f'{confidence} vs gate {gate}'
                      + (f'  gap {gap}pt' if gap else '  MEETS GATE'),
        "Setup":      f'{asset.get("setup", "-")} ({asset.get("setupTimeframe", "-")})',
        "Regime":     f'{asset.get("regime") or "-"}  '
                      f'RSI {indicators.get("rsi", "-")} ADX {indicators.get("adx", "-")}',
        "Trend D1":   asset.get("trend") or "-",
        "Trend H4":   f'{h4.get("trend", "-")} (RSI {h4.get("rsi", "-")})',
        "Trend H1":   f'{h1.get("trend", "-")} (RSI {h1.get("rsi", "-")})',
        # Measured bar geometry, NOT a signal. Sits below the trend rows so it reads as
        # context rather than as an instruction, and prints its own verdict in words.
        "1D read":    _read_row(reads or {}, symbol, "D1"),
        "4H read":    _read_row(reads or {}, symbol, "H4"),
        "Note":       (reasons[0][:64] if reasons else "-"),
    }

    plan = {
        "symbol": symbol,
        "decimals": decimals,
        "bias": bias,
        "setup": asset.get("setup"),
        "confidence": confidence,
        "gate": gate,
        "gap": gap,
        "rr": rr,
        "levels_from": levels_from,
        "price": price,
        "entry": entry,
        "stop": stop,
        "target": target,
        "support": support,
        "resistance": resistance,
        "generated_at": time.strftime("%Y-%m-%d %H:%M"),
        # The instant itself, so the chart can age its own plan. Deriving this
        # back from generated_at would mean re-parsing a LOCAL time string, and
        # the two boxes are in different timezones.
        "generated_ts_ms": int(time.time() * 1000),
        "source_note": f'{asset.get("dataSource", "unknown")} '
                       f'{asset.get("sourceSymbol", "")} '
                       f'updated {asset.get("updatedAt", "?")}',
        "rows": rows,
    }

    # A squeeze watch publishes its triggers in the reason text rather than as
    # fields, so surface them as levels when the engine names them.
    for reason in (asset.get("reasons") or []):
        if "break above" in reason.lower():
            numbers = [t.replace(",", "") for t in reason.replace("(", " ").replace(")", " ").split()
                       if t.replace(",", "").replace(".", "").isdigit()]
            if len(numbers) >= 2:
                plan["breakout_up"]   = float(numbers[0])
                plan["breakout_down"] = float(numbers[1])

    # The breakout pair is attached ABOVE, after `rows` was frozen, so the Pivots row
    # has to be recomputed here or a squeeze watch would publish its triggers to
    # nothing. Built from the finished plan, which is the only point at which all
    # four context levels are known.
    plan["rows"]["Pivots"] = _context_row(plan)
    return plan


# ── Main commands ─────────────────────────────────────────────────────────────
def _get_tv_page(ctx):
    """Return existing TradingView page from context, or open a new tab."""
    for p in ctx.pages:
        if "tradingview.com" in p.url:
            return p
    return ctx.new_page()

def _run(fn):
    """Attach to running Edge on port 9222 and run fn(page, ctx). Never opens a new window."""
    try:
        with sync_playwright() as pw:
            browser, ctx = make_context(pw)
            page = _get_tv_page(ctx)
            try:
                fn(page, ctx)
            finally:
                pass  # do NOT close — keep Edge alive
    except Exception as e:
        print(f"[TV] Cannot connect to Edge: {e}")
        print("[TV] Open TradingView in Edge, then run: tasks\\launch_chrome_tv.bat")

def cmd_test():
    print("[TV] Testing connection to TradingView...")
    def _test(page, ctx):
        print(f"[TV] Connected — current page: {page.url}")
        print("[TV] SUCCESS")
    _run(_test)

def cmd_draw(symbol, entry, stop, target, support=None, resistance=None):
    levels = [
        (entry,      "Entry"),
        (stop,       "Stop"),
        (target,     "Target"),
    ]
    if support:    levels.append((support,    "Support"))
    if resistance: levels.append((resistance, "Resistance"))

    def _draw(page, ctx):
        open_chart(page, symbol)
        # Try direct canvas drawing first
        drawn = sum(draw_hline(page, p, lbl) for p, lbl in levels)
        if drawn == 0:
            # Canvas selectors failed — use Pine Editor (always works)
            print("[TV] Direct drawing failed — using Pine Editor")
            draw_via_pine_editor(page, symbol, levels)
        else:
            print(f"[TV] Done: {drawn}/{len(levels)} levels drawn on {symbol}")
        time.sleep(3)
    _run(_draw)

def cmd_alert(symbol, price, message):
    def _alert(page, ctx):
        open_chart(page, symbol)
        set_alert(page, price, symbol, message)
        time.sleep(3)
    _run(_alert)

def cmd_pine(symbol, entry, stop, target, support=None, resistance=None, bias="WAIT"):
    plan = build_plan(symbol, {"signal": bias}, gate=None, overrides={
        "entry": entry, "stop": stop, "target": target,
        "support": support, "resistance": resistance,
    })
    script = generate_pine(plan)
    out_file = Path(__file__).parent / "tasks" / f"pine_{symbol.lower()}_plan.pine"
    out_file.write_text(script, encoding="utf-8")
    print(script)
    print(f"\n[TV] Pine Script saved to: {out_file}")
    print("[TV] Paste it into TradingView > Pine Script Editor, then press Ctrl+Enter")


def cmd_plan(which="all", shoot=True):
    """
    Fully automatic daily plan: read the live signals, draw one plan per symbol.

    Returns a non-zero exit code if any symbol fails, so a scheduled run that
    silently stops working is visible instead of looking like a clean pass.
    """
    signals = _get_json("/api/signals")
    if not signals:
        print("[TV] No signals — is the SmartEntry server up on :3001?")
        return 1

    gate, gate_note = fetch_live_gate()
    print(f"[TV] Live gate: {gate} ({gate_note})")

    candle_reads = load_candle_reads()
    print(f"[TV] Candle read: {sum(len(v) for v in candle_reads.values())} row(s) loaded"
          if candle_reads else "[TV] Candle read: none on disk - rows will say so")

    wanted = list(API_ASSETS) if which.lower() == "all" else [which.upper()]
    results = {}

    plans = []
    for name in wanted:
        key = API_ASSETS.get(name)
        asset = signals.get(key) if key else None
        if not asset:
            print(f"[TV] {name}: not in /api/signals — skipped")
            continue
        plans.append(build_plan(name, asset, gate, reads=candle_reads))

    if not plans:
        print("[TV] Nothing to draw")
        return 1

    pine = generate_pine(plans)

    try:
        with sync_playwright() as pw:
            browser, ctx = make_context(pw)
            SHOT_DIR.mkdir(parents=True, exist_ok=True)

            # ONE tab, ONE apply. Every chart shares a single saved layout, so a
            # study applied anywhere shows up everywhere — which is exactly why a
            # per-symbol script put BTC's plan on the Gold chart. The script picks
            # its own symbol, so applying it once covers all of them.
            tabs = [p for p in ctx.pages if "tradingview.com" in p.url]
            page = tabs[0] if tabs else ctx.new_page()
            for extra in tabs[1:]:
                try:
                    extra.close()      # TradingView counts every tab against the plan limit
                except Exception:
                    pass

            open_chart(page, plans[0]["symbol"])

            before = list_plan_studies(page)
            applied = save_pine(page, pine)
            after = list_plan_studies(page)

            # ---- What can actually be verified from here ----------------------
            #
            # Saving the SOURCE and putting the study ON a chart are different
            # operations and this only ever did the first, so the Gold chart rendered
            # an Aug-7 plan for fourteen days while "1 before, 1 after" was reported
            # as proof. That count cannot tell "updated" from "did nothing".
            #
            # An earlier attempt at this read the plan's VERSION back off the legend
            # via indicator(shorttitle=...). That does NOT work: for a study added
            # from a saved user script the legend shows the SAVED SCRIPT NAME and
            # nothing else - on 2026-08-21 the only JARVIS string in the whole DOM
            # was "JARVIS Daily Plan". Shipping it would have meant a check that can
            # never pass, and a red light that cannot go green is worse than none.
            #
            # So this asserts only what is knowable: the save landed with no unsaved
            # changes and no Pine errors, and a plan study is on the chart. WHICH
            # version renders is answered on the chart itself - Pine compares the
            # plan's embedded timestamp against timenow and shows STALE in red.
            page.wait_for_timeout(2500)

            # Gated on `applied`: adding a study can only help if the save landed.
            if not plan_study_present(page) and applied:
                print("[TV] No plan study on the chart - adding it.")
                add_script_to_chart(page)
                page.wait_for_timeout(2500)
                after = list_plan_studies(page)

            present = plan_study_present(page)
            verified = applied and present
            if not applied:
                print("[TV] Save did not land - the chart was left exactly as it was.")
            elif not present:
                print(f"[TV] Save landed but no plan study is on the chart. Add "
                      f"{SAVED_SCRIPT_NAME!r} to the layout once by hand; every run "
                      "after that updates it in place.")
            else:
                print("[TV] Saved, and a plan study is on the chart. The plan carries "
                      "its own age - a missed run shows STALE in red on the chart.")


            if applied and shoot:
                # Same tab, same study — switch symbols only to capture each chart.
                for plan in plans:
                    try:
                        open_chart(page, plan["symbol"])
                        page.wait_for_timeout(4000)
                        page.screenshot(
                            path=str(SHOT_DIR / f"plan_{plan['symbol'].lower()}.png"))
                        results[plan["symbol"]] = verified
                    except Exception as exc:
                        print(f"[TV] {plan['symbol']} screenshot: {exc}")
                        # A failed capture does not un-draw the plan, so this follows
                        # the VERIFIED state rather than asserting success. It used to
                        # be a hardcoded True, which is why fourteen days of a stale
                        # chart reported as a clean pass.
                        results[plan["symbol"]] = verified
            else:
                for plan in plans:
                    results[plan["symbol"]] = applied and verified
    except Exception as exc:
        # This said "Cannot connect to Edge" for ANY exception raised inside the
        # page, including ordinary click timeouts on a browser it was already
        # attached to. That misdirection cost two debugging rounds on 2026-08-21.
        detail = str(exc).splitlines()[0][:160]
        print(f"[TV] Plan run failed: {detail}")
        if "connect" in detail.lower() or "browser" in detail.lower():
            print("[TV] Is Edge up on CDP 9222? Run: tasks" + chr(92) + "launch_chrome_tv.bat")
        return 1

    ok = [n for n, good in results.items() if good]
    bad = [n for n, good in results.items() if not good]
    print(f"\n[TV] Plan drawn: {', '.join(ok) if ok else 'none'}"
          + (f" | FAILED: {', '.join(bad)}" if bad else ""))
    return 0 if ok and not bad else 1

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    cmd = args[0].lower()

    if cmd == "test":
        cmd_test()

    elif cmd == "draw":
        if len(args) < 5:
            print("Usage: python tradingview_bot.py draw [symbol] [entry] [stop] [target] [support?] [resistance?]")
            sys.exit(1)
        cmd_draw(
            symbol     = args[1],
            entry      = float(args[2]),
            stop       = float(args[3]),
            target     = float(args[4]),
            support    = float(args[5]) if len(args) > 5 else None,
            resistance = float(args[6]) if len(args) > 6 else None,
        )

    elif cmd == "plan":
        sys.exit(cmd_plan(args[1] if len(args) > 1 else "all"))

    elif cmd == "alert":
        if len(args) < 4:
            print("Usage: python tradingview_bot.py alert [symbol] [price] [message]")
            sys.exit(1)
        cmd_alert(args[1], float(args[2]), args[3])

    elif cmd == "pine":
        if len(args) < 5:
            print("Usage: python tradingview_bot.py pine [symbol] [entry] [stop] [target] [support?] [resistance?] [bias?]")
            sys.exit(1)
        cmd_pine(
            symbol     = args[1],
            entry      = float(args[2]),
            stop       = float(args[3]),
            target     = float(args[4]),
            support    = float(args[5]) if len(args) > 5 else None,
            resistance = float(args[6]) if len(args) > 6 else None,
            bias       = args[7].upper() if len(args) > 7 else "WAIT",
        )

    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)
