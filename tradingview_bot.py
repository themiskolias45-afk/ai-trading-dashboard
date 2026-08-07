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
CHROME_USER_DATA = r"C:\Users\User\AppData\Local\Microsoft\Edge\SmartEntryTV"
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


def generate_pine(plan):
    """
    Build ONE daily-plan indicator for a symbol.

    plan is the dict from build_plan(): levels plus the analysis that justifies
    them. Everything the plan claims is rendered, so the chart and the engine can
    never disagree — if a field is missing it prints as "-" rather than being
    quietly dropped.
    """
    symbol   = plan["symbol"]
    decimals = plan["decimals"]
    bias     = plan.get("bias") or "WAIT"

    bias_color = {"LONG": "color.new(color.green, 0)",
                  "SHORT": "color.new(color.red, 0)"}.get(bias, "color.new(color.gray, 0)")

    lines, labels = [], []

    def level(price, colour, width, style, text):
        if price is None:
            return
        lines.append(
            f'    line.new(bar_index - 120, {price}, bar_index + 20, {price}, '
            f'extend=extend.right, color={colour}, width={width}, style={style})'
        )
        labels.append(
            f'    label.new(bar_index + 20, {price}, {_pine_str(text)}, '
            f'color={colour}, textcolor=color.white, '
            f'style=label.style_label_left, size=size.small)'
        )

    # A pivot fallback is not a trade, so it must not be labelled like one.
    is_setup = plan.get("levels_from", "engine") == "engine"
    tag = {"entry": "Entry" if is_setup else "Price",
           "stop":  "Stop"  if is_setup else "S2",
           "target": "Target" if is_setup else "R2"}

    level(plan.get("entry"),  "color.new(color.green, 0)", 2, "line.style_dashed",
          f'{tag["entry"]} {_fmt(plan.get("entry"), decimals)}')
    level(plan.get("stop"),   "color.new(color.red, 0)",   2, "line.style_dashed",
          f'{tag["stop"]} {_fmt(plan.get("stop"), decimals)}')
    level(plan.get("target"), "color.new(color.blue, 0)",  2, "line.style_dashed",
          f'{tag["target"]} {_fmt(plan.get("target"), decimals)}')
    level(plan.get("resistance"), "color.new(#EF9A9A, 0)", 1, "line.style_dotted",
          f'R1 {_fmt(plan.get("resistance"), decimals)}')
    level(plan.get("support"),    "color.new(#64B5F6, 0)", 1, "line.style_dotted",
          f'S1 {_fmt(plan.get("support"), decimals)}')

    # Breakout triggers only exist for a squeeze watch, so they are optional.
    level(plan.get("breakout_up"),   "color.new(color.olive, 0)", 1, "line.style_dotted",
          f'Break BUY {_fmt(plan.get("breakout_up"), decimals)}')
    level(plan.get("breakout_down"), "color.new(color.maroon, 0)", 1, "line.style_dotted",
          f'Break SELL {_fmt(plan.get("breakout_down"), decimals)}')

    rows = plan["table_rows"]
    cells = []
    for i, (key, value) in enumerate(rows):
        cells.append(
            f'    table.cell(planTable, 0, {i + 1}, {_pine_str(key)}, '
            f'text_color=color.gray, text_size=size.small, text_halign=text.align_left)'
        )
        cells.append(
            f'    table.cell(planTable, 1, {i + 1}, {_pine_str(value)}, '
            f'text_color=color.white, text_size=size.small, text_halign=text.align_left)'
        )

    if not lines:
        lines.append("    // no levels available for this asset today")

    newline = chr(10)
    return f"""//@version=5
indicator({_pine_str(f"JARVIS Daily Plan - {symbol}")}, overlay=true, max_lines_count=40, max_labels_count=40)

// Generated by JARVIS - {plan["generated_at"]}
// Source: {plan["source_note"]}
// Bias: {bias} | Setup: {plan.get("setup")} | Confidence: {plan.get("confidence")} vs gate {plan.get("gate")}

var table planTable = table.new(position.top_right, 2, {len(rows) + 1},
     border_width=1, frame_width=1, frame_color=color.new(color.gray, 40),
     bgcolor=color.new(color.black, 15))

if barstate.islast
    table.cell(planTable, 0, 0, {_pine_str(f"JARVIS PLAN - {symbol}")},
         text_color=color.white, text_size=size.normal, text_halign=text.align_left)
    table.cell(planTable, 1, 0, {_pine_str(bias)},
         text_color=color.white, bgcolor={bias_color},
         text_size=size.normal, text_halign=text.align_left)

{newline.join(cells)}

{newline.join(lines)}

{newline.join(labels)}
"""

# ── Pine Editor auto-paste ────────────────────────────────────────────────────
def _editor_text(page):
    """
    Read what is in the Pine editor.

    Two traps here. Monaco renders every space as U+00A0, so normalise before
    comparing. And .view-lines is virtualised — it holds only the lines currently
    scrolled into view, so after a paste it shows the END of the script and a check
    against line 1 fails on a script that landed perfectly. The caller must scroll
    to the top before trusting the first line.
    """
    return page.locator(SEL_EDITOR_TEXT).first.inner_text().replace("\xa0", " ")


def _scroll_editor_top(page):
    page.keyboard.press("Control+Home")
    page.wait_for_timeout(800)


def apply_pine(page, pine, symbol):
    """
    Put one Pine script on the chart currently open in `page`.

    Applying is Ctrl+Enter: a signed-in session has no "Add to chart" button. Every
    apply adds ANOTHER copy of the indicator, which is why the caller reloads the
    chart first — unsaved studies do not survive a reload, so a re-run replaces the
    plan instead of stacking a second one on top of it.
    """
    page.bring_to_front()
    page.wait_for_selector(SEL_PINE_BUTTON, timeout=45000)
    page.wait_for_timeout(3000)
    page.click(SEL_PINE_BUTTON)

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
        print(f"[TV] {symbol}: script did not land cleanly; editor starts {landed[:60]!r}")
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


def build_plan(symbol, asset, gate=None, overrides=None):
    """
    Turn one asset block from /api/signals into everything the chart should show.

    A WAIT asset still gets a plan: whatever levels the engine did compute, else
    the pivots, plus the analysis that explains why it is not firing. That is the
    point of a daily plan — knowing what would have to happen, not just what fired.
    """
    overrides = overrides or {}
    indicators = asset.get("indicators") or {}
    pivots     = asset.get("pivots") or {}
    structure  = asset.get("structure") or {}
    h4         = asset.get("h4") or {}
    h1         = asset.get("h1") or {}
    volume     = asset.get("volume") or {}

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

    rows = [
        ("Date",       time.strftime("%Y-%m-%d %H:%M")),
        ("Setup",      f'{asset.get("setup", "-")} ({asset.get("setupTimeframe", "-")})'),
        ("Strength",   asset.get("strength") or "-"),
        ("Confidence", f'{confidence} vs gate {gate}'
                       + (f'  gap {gap}pt' if gap else '  MEETS GATE')),
        ("Levels",     "engine setup" if levels_from == "engine"
                       else "PIVOT BAND - not a setup"),
        ("R:R",        f'{rr}' if rr else "n/a (no setup)"),
        ("Regime",     asset.get("regime") or "-"),
        ("Session",    (asset.get("session") or {}).get("name") or "-"),
        ("Trend D1",   asset.get("trend") or "-"),
        ("Trend H4",   f'{h4.get("trend", "-")} (RSI {h4.get("rsi", "-")})'),
        ("Trend H1",   f'{h1.get("trend", "-")} (RSI {h1.get("rsi", "-")})'),
        ("RSI / ADX",  f'{indicators.get("rsi", "-")} / {indicators.get("adx", "-")}'),
        ("Volume",     f'{volume.get("ratio", "-")}x avg'
                       + ("" if volume.get("confirmed") else " (unconfirmed)")),
        ("Swing",      f'{_fmt(structure.get("swingLow"), decimals)} - '
                       f'{_fmt(structure.get("swingHigh"), decimals)}'),
        ("Feed",       f'{asset.get("dataSource", "-")}:{asset.get("sourceSymbol", "-")}'),
    ]
    for i, reason in enumerate((asset.get("reasons") or [])[:3]):
        rows.append((f"Why {i + 1}", reason[:70]))

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
        "source_note": f'{asset.get("dataSource", "unknown")} '
                       f'{asset.get("sourceSymbol", "")} '
                       f'updated {asset.get("updatedAt", "?")}',
        "table_rows": rows,
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

    wanted = list(API_ASSETS) if which.lower() == "all" else [which.upper()]
    results = {}

    try:
        with sync_playwright() as pw:
            browser, ctx = make_context(pw)
            SHOT_DIR.mkdir(parents=True, exist_ok=True)

            # One tab per symbol, held open: a plan lives only on the chart it was
            # applied to, so reusing a single tab would discard each plan as the
            # next symbol loaded. Existing TV tabs are reused rather than added to,
            # because TradingView counts every tab against the plan's connection
            # limit and refuses new ones once it is hit.
            spare = [p for p in ctx.pages if "tradingview.com" in p.url]
            for name in wanted:
                key = API_ASSETS.get(name)
                asset = signals.get(key) if key else None
                if not asset:
                    print(f"[TV] {name}: not in /api/signals — skipped")
                    results[name] = False
                    continue

                page = spare.pop(0) if spare else ctx.new_page()
                try:
                    plan = build_plan(name, asset, gate)
                    # open_chart navigates, and unsaved studies do not survive a
                    # navigation — that is what stops a re-run stacking a second
                    # copy of the plan on top of the first.
                    open_chart(page, name)
                    results[name] = apply_pine(page, generate_pine(plan), name)
                    if shoot:
                        page.screenshot(path=str(SHOT_DIR / f"plan_{name.lower()}.png"))
                except Exception as exc:
                    print(f"[TV] {name}: {type(exc).__name__}: {exc}")
                    results[name] = False

            # Any TV tabs beyond the ones we just used are leftovers.
            for stale in spare:
                try:
                    stale.close()
                except Exception:
                    pass
    except Exception as exc:
        print(f"[TV] Cannot connect to Edge: {exc}")
        print("[TV] Run: tasks\\launch_chrome_tv.bat")
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
