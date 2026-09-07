"""
Chart Vision — JARVIS eyes on TradingView charts
Takes a screenshot of the open TradingView window and sends it to Claude Vision.
Claude identifies patterns, key levels, trend structure, and trade setup quality.

Usage:
  python chart_vision.py [BTC|GOLD|SPX]
  python chart_vision.py analyze path/to/screenshot.png
  python chart_vision.py watch [symbol]
"""
import sys, os, time, base64, json
from pathlib import Path
from datetime import datetime

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).parent
SCREENSHOTS_DIR = PROJECT_ROOT / "tasks" / "screenshots"
API_KEY_PATH = PROJECT_ROOT / "server" / "apikey.txt"
# CLAUDE.md assigns claude-sonnet-5 to "per-asset commentary, summaries and
# analysis", and reading one asset's chart is exactly that; claude-opus-5 is
# reserved there for the JARVIS brain and the /engineer split. This was still on
# claude-opus-4-8 — a THIRD call site the 2026-08-02 sweep missed, while CLAUDE.md
# recorded that "both remaining call sites were upgraded". The model is still
# valid, so nothing was failing; the rule was just quietly untrue.
CLAUDE_MODEL = "claude-sonnet-5"
WATCH_INTERVAL_SECONDS = 1800  # 30 minutes
ANALYSIS_PROMPT_TEMPLATE = (
    "You are an expert technical analyst. Analyze this {symbol} chart:\n"
    "1. Trend structure (higher highs/lows or lower?)\n"
    "2. Key support and resistance levels (exact prices if visible)\n"
    "3. Pattern forming (if any: flag, wedge, H&S, triangle, etc.)\n"
    "4. Candlestick patterns at the current price\n"
    "5. Momentum assessment (building or fading?)\n"
    "6. Trade setup quality: STRONG / MODERATE / WEAK / NO SETUP\n"
    "7. Recommended action: BUY / SELL / WAIT + reason\n"
    "Be specific with price levels. Under 200 words."
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ensure_screenshots_dir() -> None:
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)


def _load_api_key() -> str:
    if not API_KEY_PATH.exists():
        raise FileNotFoundError(
            f"API key not found at {API_KEY_PATH}. "
            "Place your Anthropic API key in server/apikey.txt."
        )
    key = API_KEY_PATH.read_text(encoding="utf-8").strip()
    if not key:
        raise ValueError("API key file is empty.")
    return key


def _timestamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _safe_symbol(symbol: str) -> str:
    return "".join(c for c in symbol if c.isalnum() or c in "-_").upper() or "CHART"


# ---------------------------------------------------------------------------
# Screenshot: CDP via Playwright
# ---------------------------------------------------------------------------

def _screenshot_via_cdp(symbol: str) -> Path:
    """Connect to Chrome DevTools Protocol on localhost:9222 and screenshot the active TradingView tab."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise ImportError("playwright not installed — run: pip install playwright && playwright install chromium")

    _ensure_screenshots_dir()
    out_path = SCREENSHOTS_DIR / f"{_safe_symbol(symbol)}_{_timestamp()}.png"

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.connect_over_cdp("http://localhost:9222")
        except Exception as exc:
            raise ConnectionError(f"CDP connect failed: {exc}") from exc

        # Find the first TradingView page
        target_page = None
        for ctx in browser.contexts:
            for page in ctx.pages:
                if "tradingview.com" in page.url.lower():
                    target_page = page
                    break
            if target_page:
                break

        if target_page is None:
            # Fall back to whatever is the active/first page
            for ctx in browser.contexts:
                if ctx.pages:
                    target_page = ctx.pages[0]
                    break

        if target_page is None:
            browser.close()
            raise RuntimeError("No open browser pages found via CDP.")

        target_page.screenshot(path=str(out_path), full_page=False)
        browser.close()

    return out_path


# ---------------------------------------------------------------------------
# Screenshot: pyautogui fallback
# ---------------------------------------------------------------------------

def _screenshot_via_pyautogui(symbol: str) -> Path:
    """Fallback: screenshot the entire screen using pyautogui."""
    try:
        import pyautogui
    except ImportError:
        raise ImportError("pyautogui not installed — run: pip install pyautogui")

    _ensure_screenshots_dir()
    out_path = SCREENSHOTS_DIR / f"{_safe_symbol(symbol)}_{_timestamp()}.png"

    screenshot = pyautogui.screenshot()
    screenshot.save(str(out_path))
    return out_path


# ---------------------------------------------------------------------------
# Public: take_screenshot
# ---------------------------------------------------------------------------

def take_screenshot(symbol: str) -> Path:
    """
    Try CDP first; fall back to pyautogui.
    Returns the Path of the saved screenshot.
    """
    symbol = _safe_symbol(symbol)

    # Attempt CDP
    try:
        path = _screenshot_via_cdp(symbol)
        print(f"Screenshot saved (CDP): {path}")
        return path
    except ImportError as exc:
        print(f"[WARN] CDP unavailable — {exc}")
    except ConnectionError as exc:
        print(f"[WARN] CDP connection failed — {exc}")
    except Exception as exc:
        print(f"[WARN] CDP screenshot failed — {exc}")

    # Attempt pyautogui fallback
    try:
        path = _screenshot_via_pyautogui(symbol)
        print(f"Screenshot saved (pyautogui): {path}")
        return path
    except ImportError as exc:
        raise RuntimeError(
            "Neither playwright nor pyautogui is available.\n"
            "Install one of:\n"
            "  pip install playwright && playwright install chromium\n"
            "  pip install pyautogui"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"pyautogui screenshot failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Public: analyze_chart
# ---------------------------------------------------------------------------

def analyze_chart(image_path: str | Path, symbol: str) -> str:
    """
    Send image to Claude Vision and return the analysis text.
    """
    image_path = Path(image_path)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    api_key = _load_api_key()

    # Encode image
    raw = image_path.read_bytes()
    b64_data = base64.standard_b64encode(raw).decode("utf-8")

    # Detect media type
    suffix = image_path.suffix.lower()
    media_type_map = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    media_type = media_type_map.get(suffix, "image/png")

    prompt = ANALYSIS_PROMPT_TEMPLATE.format(symbol=symbol.upper())

    payload = {
        "model": CLAUDE_MODEL,
        "max_tokens": 512,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": prompt,
                    },
                ],
            }
        ],
    }

    import urllib.request
    import urllib.error

    req_body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=req_body,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Anthropic API error {exc.code}: {error_body}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error calling Anthropic API: {exc.reason}") from exc

    # Extract text from response
    try:
        content_blocks = body["content"]
        text_parts = [block["text"] for block in content_blocks if block.get("type") == "text"]
        return "\n".join(text_parts).strip()
    except (KeyError, TypeError) as exc:
        raise RuntimeError(f"Unexpected API response shape: {exc}\nFull response: {body}") from exc


# ---------------------------------------------------------------------------
# Public: run
# ---------------------------------------------------------------------------

def run(symbol: str) -> None:
    """Take a screenshot, analyze it, print the result, and save to disk."""
    symbol = _safe_symbol(symbol)

    print(f"[chart_vision] Capturing {symbol} chart...")
    image_path = take_screenshot(symbol)

    print(f"[chart_vision] Sending to Claude Vision ({CLAUDE_MODEL})...")
    analysis = analyze_chart(image_path, symbol)

    separator = "=" * 60
    print(f"\n{separator}")
    print(f"  CHART ANALYSIS — {symbol}  |  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(separator)
    print(analysis)
    print(separator)

    # Save analysis alongside screenshot
    analysis_path = SCREENSHOTS_DIR / f"{symbol}_analysis.txt"
    analysis_path.write_text(
        f"Symbol: {symbol}\n"
        f"Timestamp: {datetime.now().isoformat()}\n"
        f"Screenshot: {image_path}\n"
        f"\n{analysis}\n",
        encoding="utf-8",
    )
    print(f"[chart_vision] Analysis saved: {analysis_path}")


# ---------------------------------------------------------------------------
# Watch mode
# ---------------------------------------------------------------------------

def watch(symbol: str) -> None:
    """Analyze chart every 30 minutes until interrupted."""
    symbol = _safe_symbol(symbol)
    print(f"[chart_vision] Watch mode — analyzing {symbol} every {WATCH_INTERVAL_SECONDS // 60} min. Ctrl-C to stop.")
    while True:
        try:
            run(symbol)
        except Exception as exc:
            print(f"[ERROR] Analysis failed: {exc}")
        print(f"\nNext analysis in {WATCH_INTERVAL_SECONDS // 60} minutes...\n")
        try:
            time.sleep(WATCH_INTERVAL_SECONDS)
        except KeyboardInterrupt:
            print("\n[chart_vision] Watch mode stopped.")
            break


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    args = sys.argv[1:]

    if not args:
        # Default: screenshot + analyze whatever TV window is open
        run("CHART")
        return

    command = args[0].lower()

    if command == "analyze":
        if len(args) < 2:
            print("Usage: python chart_vision.py analyze <path/to/screenshot.png>")
            sys.exit(1)
        file_path = Path(args[1])
        symbol = file_path.stem.split("_")[0].upper() or "CHART"
        try:
            analysis = analyze_chart(file_path, symbol)
        except (FileNotFoundError, RuntimeError, ValueError) as exc:
            print(f"[ERROR] {exc}")
            sys.exit(1)
        separator = "=" * 60
        print(f"\n{separator}")
        print(f"  CHART ANALYSIS — {symbol}  |  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(separator)
        print(analysis)
        print(separator)
        return

    if command == "watch":
        symbol = args[1] if len(args) > 1 else "CHART"
        try:
            watch(symbol)
        except KeyboardInterrupt:
            print("\n[chart_vision] Stopped.")
        return

    # Any other argument is treated as the symbol
    symbol = args[0]
    try:
        run(symbol)
    except (RuntimeError, FileNotFoundError, ValueError) as exc:
        print(f"[ERROR] {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
