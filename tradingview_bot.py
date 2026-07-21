"""
TradingView Bot — JARVIS automation
Login, draw daily plan levels, set price alerts, generate Pine Script

Usage:
  python tradingview_bot.py test                          # test login
  python tradingview_bot.py draw BTC 105000 103500 107000 104000 106500
  python tradingview_bot.py alert BTC 107000 "Resistance — watch for rejection"
  python tradingview_bot.py pine BTC 105000 103500 107000 104000 106500
"""

import sys, os, time, json
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
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

CHART_SYMBOLS = {
    "BTC":    "BINANCE:BTCUSDT",
    "GOLD":   "TVC:GOLD",
    "SPX":    "SP:SPX",
    "BTCUSD": "BINANCE:BTCUSDT",
    "XAUUSD": "TVC:GOLD",
    "SP500":  "SP:SPX",
    "SPY":    "SP:SPX",
}

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

# ── Connect to existing Chrome via remote debug port ───────────────────────────
CHROME_DEBUG_URL  = "http://localhost:9222"
CHROME_USER_DATA  = r"C:\Users\User\AppData\Local\Google\Chrome\User Data"
SESSION_FILE      = Path(__file__).parent / "tasks" / ".tv_session.json"

def make_context(playwright):
    """
    Priority:
    1. Connect to Chrome already open with --remote-debugging-port=9222 (best)
    2. Launch Chrome with user profile (close Chrome first)
    3. Use saved session cookies
    """
    # Option 1: Connect to existing Chrome (user ran tasks\launch_chrome_tv.bat)
    try:
        browser = playwright.chromium.connect_over_cdp(CHROME_DEBUG_URL, timeout=3000)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()
        print("[TV] Connected to your open Chrome browser")
        return browser, ctx
    except:
        pass

    # Option 2: Launch Chrome fresh with profile
    if os.path.exists(CHROME_PATH):
        print("[TV] Opening Chrome with your profile...")
        try:
            ctx = playwright.chromium.launch_persistent_context(
                user_data_dir=CHROME_USER_DATA,
                executable_path=CHROME_PATH,
                headless=False,
                args=["--start-maximized", "--profile-directory=Default",
                      "--remote-debugging-port=9222"],
                no_viewport=True,
            )
            return None, ctx
        except Exception as e:
            print(f"[TV] Could not open Chrome profile: {e}")

    # Option 3: Saved session in standalone Chromium
    launch_args = {"headless": False, "args": ["--start-maximized"]}
    browser = playwright.chromium.launch(**launch_args)
    if SESSION_FILE.exists():
        try:
            storage = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
            ctx = browser.new_context(storage_state=storage)
            print("[TV] Using saved session")
            return browser, ctx
        except:
            pass
    ctx = browser.new_context()
    return browser, ctx

def save_session(ctx):
    try:
        SESSION_FILE.parent.mkdir(exist_ok=True)
        SESSION_FILE.write_text(json.dumps(ctx.storage_state()), encoding="utf-8")
    except:
        pass

# ── Login ─────────────────────────────────────────────────────────────────────
def login(page, ctx):
    """Login to TradingView. Handles 2FA — waits for user to enter code."""
    username = get_cred("TV_USERNAME")
    password = get_cred("TV_PASSWORD")
    if not username or not password:
        print("ERROR: TV_USERNAME / TV_PASSWORD missing in keys.env")
        print("Run: tasks\\setup_tradingview.bat")
        sys.exit(1)

    page.goto(f"{TV_BASE}/")
    page.wait_for_load_state("domcontentloaded")
    time.sleep(2)

    # Already logged in from saved session?
    try:
        if page.locator('[data-name="header-user-menu-button"]').count() > 0:
            print("[TV] Already logged in (session active)")
            return
    except:
        pass

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
    tv_sym = CHART_SYMBOLS.get(symbol.upper(), symbol)
    page.goto(f"{TV_BASE}/chart/?symbol={tv_sym}")
    page.wait_for_load_state("networkidle", timeout=30000)
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
def generate_pine(symbol, entry, stop, target, support=None, resistance=None, bias="WAIT"):
    """Generate Pine Script with hardcoded levels — paste once into TV."""
    bias_color = "color.green" if bias == "LONG" else "color.red" if bias == "SHORT" else "color.gray"
    lines = []

    if entry:   lines.append(f'line.new(bar_index - 100, {entry}, bar_index, {entry}, extend=extend.right, color=color.green,  width=2, style=line.style_dashed)')
    if stop:    lines.append(f'line.new(bar_index - 100, {stop},  bar_index, {stop},  extend=extend.right, color=color.red,    width=2, style=line.style_dashed)')
    if target:  lines.append(f'line.new(bar_index - 100, {target},bar_index, {target},extend=extend.right, color=color.blue,   width=2, style=line.style_dashed)')
    if support: lines.append(f'line.new(bar_index - 100, {support},bar_index,{support},extend=extend.right, color=#64B5F6,     width=1, style=line.style_dotted)')
    if resistance: lines.append(f'line.new(bar_index - 100, {resistance},bar_index,{resistance},extend=extend.right, color=#EF9A9A, width=1, style=line.style_dotted)')

    label_lines = []
    if entry:      label_lines.append(f'label.new(bar_index, {entry},      "Entry {entry:,.0f}",   color=color.green,  textcolor=color.white, style=label.style_label_left, size=size.small)')
    if stop:       label_lines.append(f'label.new(bar_index, {stop},       "Stop  {stop:,.0f}",    color=color.red,    textcolor=color.white, style=label.style_label_left, size=size.small)')
    if target:     label_lines.append(f'label.new(bar_index, {target},     "Target {target:,.0f}", color=color.blue,   textcolor=color.white, style=label.style_label_left, size=size.small)')

    pine = f"""//@version=5
indicator("JARVIS Daily Plan — {symbol}", overlay=true, max_lines_count=20, max_labels_count=20)

// Generated by JARVIS — {time.strftime("%Y-%m-%d %H:%M")}
// Bias: {bias}
// Entry: {entry} | Stop: {stop} | Target: {target}
// Paste this script into TradingView Pine Script editor

if barstate.islast
    // Draw levels
    {chr(10)+"    ".join(lines)}

    // Labels
    {chr(10)+"    ".join(label_lines)}
"""
    return pine

# ── Main commands ─────────────────────────────────────────────────────────────
def _run(fn):
    """Run fn(page, ctx) using real Chrome profile."""
    with sync_playwright() as pw:
        browser, ctx = make_context(pw)
        page = ctx.new_page()
        try:
            login(page, ctx)
            fn(page, ctx)
        finally:
            ctx.close()
            if browser:
                browser.close()

def cmd_test():
    print("[TV] Testing connection to TradingView...")
    def _test(page, ctx):
        print("[TV] SUCCESS — connected to your TradingView account.")
        time.sleep(3)
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
        drawn = sum(draw_hline(page, p, lbl) for p, lbl in levels)
        print(f"[TV] Done: {drawn}/{len(levels)} levels drawn on {symbol}")
        time.sleep(5)
    _run(_draw)

def cmd_alert(symbol, price, message):
    def _alert(page, ctx):
        open_chart(page, symbol)
        set_alert(page, price, symbol, message)
        time.sleep(3)
    _run(_alert)

def cmd_pine(symbol, entry, stop, target, support=None, resistance=None, bias="WAIT"):
    script = generate_pine(symbol, entry, stop, target, support, resistance, bias)
    out_file = Path(__file__).parent / "tasks" / f"pine_{symbol.lower()}_plan.pine"
    out_file.write_text(script, encoding="utf-8")
    print(script)
    print(f"\n[TV] Pine Script saved to: {out_file}")
    print("[TV] Paste it into TradingView > Pine Script Editor > Add to chart")

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
