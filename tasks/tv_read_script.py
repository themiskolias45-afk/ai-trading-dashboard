"""Read a saved Pine script off TradingView, or list what is saved. READ-ONLY.

    python tasks/tv_read_script.py list
    python tasks/tv_read_script.py list swing
    python tasks/tv_read_script.py read "Swing Trend Pullback Strategy"

WHY THIS EXISTS, recorded because the lesson cost a whole session:

The operator had a working, profitable strategy on their own chart -- "Swing Trend
Pullback Strategy", profit factor 1.424 over 72 trades -- and the engine version of it
was built from the NAME alone. Four definitions were written and measured; every one
was worse than the original, and two could not fire at all. There was no way to read
the real source, so there was nothing to build FROM. That is the actual defect: a
reference implementation existed and was unreadable.

A separate file rather than a new command inside tradingview_bot.py: that module is
118k and drives saving and pasting. This only ever reads, so it stays out of the file
that can write.

NOTHING HERE SAVES, PASTES, OR ADDS TO A CHART. It opens the editor, opens the script
list, reads text, and closes the dialog it opened.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("playwright not installed for this interpreter.")
    sys.exit(1)

import tradingview_bot as tv


def open_script_dialog(page):
    """Open the Pine editor's script list. Returns True when the dialog is up."""
    if not tv.ensure_editor_open(page):
        print("[TV] FAILED: could not open the Pine editor.")
        return False
    tv.close_any_open_dialog(page)
    page.click(tv.SEL_EDITOR_AREA, timeout=8000)
    page.wait_for_timeout(600)
    page.keyboard.press("Control+o")
    page.wait_for_selector(tv.SEL_OPEN_DIALOG, timeout=15000)
    page.wait_for_timeout(1500)
    return True


def list_scripts(query):
    with sync_playwright() as pw:
        browser, ctx = tv.make_context(pw)
        page = tv._get_tv_page(ctx)
        try:
            if not open_script_dialog(page):
                return 1

            if query:
                try:
                    box = page.locator(tv.SEL_OPEN_SEARCH).first
                    if box.count() > 0:
                        box.fill(query)
                        page.wait_for_timeout(1800)
                except Exception:
                    pass

            # squash() collapses the per-character spans TradingView renders for every
            # title. Without it a name comes back one letter per line and no equality
            # test against it can ever be true -- the documented reason a previous
            # version concluded a script did not exist and created an orphan instead.
            rows = []
            blank = chr(10) + chr(10)
            try:
                for text in page.locator(tv.SEL_OPEN_DIALOG).first.all_inner_texts():
                    for chunk in text.split(blank):
                        cleaned = tv.squash(chunk)
                        if cleaned and len(cleaned) > 2:
                            rows.append(cleaned)
            except Exception as exc:
                print("[TV] could not read the dialog: " + str(exc)[:90])

            print("=" * 72)
            for row in rows[:80]:
                print("  " + row[:130])
            print("=" * 72)
            print("[TV] %d row(s)." % len(rows))
            print("[TV] The list is VIRTUALISED -- only rendered rows are readable, so if")
            print("[TV] what you want is missing, search for it: tv_read_script.py list swing")
            tv.close_any_open_dialog(page)
            return 0
        finally:
            try:
                ctx.close()
            except Exception:
                pass


def read_script(name):
    print("[TV] reading saved script: " + name)
    with sync_playwright() as pw:
        browser, ctx = tv.make_context(pw)
        page = tv._get_tv_page(ctx)
        try:
            if not tv.ensure_editor_open(page):
                print("[TV] FAILED: could not open the Pine editor.")
                return 1
            if not tv.open_saved_script(page, name):
                print("[TV] FAILED: no saved script matched that name exactly.")
                print("[TV] Run: python tasks/tv_read_script.py list")
                return 1
            page.wait_for_timeout(2500)

            # MONACO IS VIRTUALISED: .view-lines holds only what is scrolled into
            # view, so a single read returns ~33 lines of a 200-line script and looks
            # complete. tradingview_bot.py documents four separate ways this reader has
            # lied historically. So: scroll from the top in page-sized steps, read at
            # each stop, and merge on exact line text in first-seen order. Merging by
            # content rather than by index is deliberate -- the div pool is recycled
            # and repositioned, so indices are not stable between reads.
            total = None
            try:
                total = tv._editor_line_count(page)
            except Exception:
                pass

            tv._scroll_editor_top(page)
            page.wait_for_timeout(800)

            seen = []
            seen_set = set()
            stalls = 0
            for _ in range(60):
                chunk = tv._editor_text(page) or ""
                added = 0
                for line in chunk.split(chr(10)):
                    key = line.rstrip()
                    if key not in seen_set:
                        seen_set.add(key)
                        seen.append(line)
                        added += 1
                if added == 0:
                    stalls += 1
                    if stalls >= 3:
                        break
                else:
                    stalls = 0
                try:
                    page.keyboard.press("PageDown")
                except Exception:
                    break
                page.wait_for_timeout(450)

            text = chr(10).join(seen)
            if total:
                print("[TV] editor reports %d lines; captured %d unique" % (total, len(seen)))
            if not text or not text.strip():
                print("[TV] FAILED: the editor returned no text.")
                return 2
            print("=" * 72)
            print(text)
            print("=" * 72)
            print("[TV] %d lines read." % len(text.splitlines()))
            return 0
        finally:
            try:
                ctx.close()
            except Exception:
                pass


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 0
    cmd = args[0].lower()
    if cmd == "list":
        return list_scripts(" ".join(args[1:]) if len(args) > 1 else "")
    if cmd == "read":
        if len(args) < 2:
            print('usage: tv_read_script.py read "Exact Script Name"')
            return 1
        return read_script(" ".join(args[1:]))
    print("unknown command: " + cmd)
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
