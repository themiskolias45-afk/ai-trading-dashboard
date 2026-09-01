"""
JARVIS Notification Engine
Sends push notifications when signals fire, system heals, or trade closes.

Channels:
  - Windows toast notification (always works, no setup)
  - Email (SMTP — configure in keys.env)
  - Webhook (any URL — Discord, Slack, custom)

Usage:
  python notifications.py signal BTC LONG 87 "Entry 105000"
  python notifications.py alert "Server restarted — all systems nominal"
  python notifications.py trade-closed BTC WIN 250.50
  python notifications.py test
"""
import sys, os, json, smtplib, urllib.request, subprocess
from pathlib import Path
from email.mime.text import MIMEText


KEYS_ENV_PATH = Path(__file__).parent / "keys.env"


def get_cred(key: str) -> str:
    """Read a single value from keys.env. Returns empty string if not found."""
    if not KEYS_ENV_PATH.exists():
        return ""
    try:
        for line in KEYS_ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, _, v = line.partition("=")
                if k.strip() == key:
                    return v.strip()
    except Exception:
        pass
    return ""


def toast(title: str, message: str) -> None:
    """
    Show a Windows message box via PowerShell + System.Windows.Forms.
    Falls back silently on non-Windows or if PowerShell is unavailable.
    """
    # Truncate for readability
    display_msg = message[:100] if len(message) > 100 else message

    # Escape single quotes to avoid breaking the PowerShell string literals
    safe_title = title.replace("'", "''")
    safe_msg = display_msg.replace("'", "''")

    ps_command = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        f"[System.Windows.Forms.MessageBox]::Show('{safe_msg}', '{safe_title}', 'OK', 'Information')"
    )

    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_command],
            timeout=10,
            capture_output=True,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        # PowerShell not available (Linux/Mac) or timed out — skip silently
        pass
    except Exception:
        pass


def send_email(subject: str, body: str) -> None:
    """
    Send an email via SMTP using credentials from keys.env.
    Required keys: EMAIL_FROM, EMAIL_TO, EMAIL_SMTP, EMAIL_PORT, EMAIL_PASS
    Skips silently if any required key is missing.
    """
    email_from = get_cred("EMAIL_FROM")
    email_to = get_cred("EMAIL_TO")
    smtp_host = get_cred("EMAIL_SMTP")
    smtp_port_str = get_cred("EMAIL_PORT")
    email_pass = get_cred("EMAIL_PASS")

    if not all([email_from, email_to, smtp_host, smtp_port_str, email_pass]):
        return

    try:
        smtp_port = int(smtp_port_str)
    except ValueError:
        return

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = email_from
    msg["To"] = email_to

    try:
        if smtp_port == 465:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=10) as server:
                server.login(email_from, email_pass)
                server.sendmail(email_from, [email_to], msg.as_string())
        else:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
                server.ehlo()
                server.starttls()
                server.login(email_from, email_pass)
                server.sendmail(email_from, [email_to], msg.as_string())
    except Exception:
        pass


def send_webhook(payload_dict: dict) -> None:
    """
    POST JSON to the configured webhook URL.
    Discord expects a "content" key; generic webhooks accept any JSON.
    Skips silently if WEBHOOK_URL is not set.
    """
    webhook_url = get_cred("WEBHOOK_URL")
    if not webhook_url:
        return

    try:
        data = json.dumps(payload_dict).encode("utf-8")
        req = urllib.request.Request(
            webhook_url,
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "JARVIS/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            _ = resp.read()
    except Exception:
        pass


def notify_signal(symbol: str, direction: str, confidence: str, summary: str) -> None:
    """
    Fire a signal notification on all channels.
    Format: JARVIS SIGNAL: [direction] [symbol] [confidence]% — [summary]
    """
    title = "JARVIS SIGNAL"
    body = f"JARVIS SIGNAL: {direction} {symbol} {confidence}% — {summary}"

    toast(title, body)

    send_email(
        subject=f"[JARVIS] SIGNAL: {direction} {symbol} {confidence}%",
        body=f"{body}\n\nReview the dashboard at http://localhost:3001",
    )

    send_webhook({
        "content": body,
        "embeds": [{
            "title": title,
            "description": body,
            "color": 3066993 if direction.upper() == "LONG" else 15158332,
            "fields": [
                {"name": "Symbol", "value": symbol, "inline": True},
                {"name": "Direction", "value": direction.upper(), "inline": True},
                {"name": "Confidence", "value": f"{confidence}%", "inline": True},
                {"name": "Summary", "value": summary, "inline": False},
            ],
        }],
    })

    # SIGNAL FIRES -> Slack #smartentry-alerts.
    # Last in the function and returning nothing any caller branches on: a Slack
    # outage, a bad token or a timeout must cost a MESSAGE, never a TRADE. send_slack
    # is try/except throughout and cannot raise, so this cannot suppress a setup that
    # would otherwise have fired (rule 3).
    send_slack("*" + title + "*" + chr(10) + body)


def send_telegram(text: str) -> None:
    """
    POST a message to the configured Telegram chat. Skips silently if not configured.

    WHY THIS EXISTS: every other channel here is useless on the box that matters.
    notify_alert was toast + webhook; WEBHOOK_URL is not set, so send_webhook skips
    silently and the whole thing collapsed to a Windows toast. A toast reaches nobody
    on the headless VPS - which is the machine that trades continuously - so a band
    firing or a health alert raised there went to no one at all.

    TELEGRAM_TOKEN and TELEGRAM_CHAT_ID were already sitting in keys.env, read by the
    server and by nothing else. The credentials existed and this file simply never
    looked at them: a writer with no reader, the mirror of the bug this project keeps
    finding in the other direction.

    THE TOKEN IS IN THE URL. urllib raises HTTPError whose str() includes the full URL,
    so an unscrubbed exception would print the bot token straight into a log file that
    gets committed and read. Every error path below scrubs it. Never widen these except
    blocks to print a raw exception.
    """
    token = get_cred("TELEGRAM_TOKEN") or os.environ.get("TELEGRAM_TOKEN", "")
    chat_id = get_cred("TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        return

    def _scrub(text_in: str) -> str:
        """Remove the bot token from anything about to be printed."""
        return str(text_in).replace(token, "<TELEGRAM_TOKEN>")

    try:
        payload = json.dumps({
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": True,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "JARVIS/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                print(f"[NOTIFY] Telegram returned HTTP {resp.status}")
    except Exception as exc:
        print(f"[NOTIFY] Telegram failed: {_scrub(exc)[:200]}")


def send_slack(text: str, channel_id: str = "") -> bool:
    """POST to Slack. Skips silently and returns False if not configured.

    NEVER RAISES. This sits on the alert path, and the alert path is reached from
    trade-open and signal-fire handlers. Rule 3 says no change may suppress a setup
    that would otherwise have fired, so a Slack outage, a bad token or a network
    timeout must cost a MESSAGE and never a TRADE. Everything below is inside
    try/except and the return value is advisory only - no caller branches on it in a
    way that can stop an order.

    Needs BOTH, and a channel id is not a credential:
      SLACK_BOT_TOKEN   xoxb-... with chat:write
      SLACK_CHANNEL_ID  defaults to the #smartentry-alerts id below
    The bot must also be INVITED to the channel - `/invite @YourBot` in Slack. A valid
    token posting to a channel it was never added to fails with `not_in_channel`, which
    is reported here rather than swallowed, because that failure is fixed by a human
    action and no amount of retrying helps.
    """
    token = get_cred("SLACK_BOT_TOKEN")
    chan  = channel_id or get_cred("SLACK_CHANNEL_ID") or "C0BUC0SQWTW"
    if not token:
        return False
    try:
        import json as _json
        import urllib.request as _rq
        req = _rq.Request(
            "https://slack.com/api/chat.postMessage",
            data=_json.dumps({"channel": chan, "text": text[:3900]}).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json; charset=utf-8"},
        )
        with _rq.urlopen(req, timeout=10) as r:
            body = _json.loads(r.read().decode("utf-8", "replace"))
        if not body.get("ok"):
            # Slack returns HTTP 200 with ok:false, so a status check alone reads as
            # success. Name the error - `not_in_channel` and `invalid_auth` need a
            # person, and a silent false would look identical to "not configured".
            print(f"[NOTIFY] Slack refused: {body.get('error')} (channel {chan})")
            return False
        return True
    except Exception as exc:
        print(f"[NOTIFY] Slack send failed, continuing: {exc}")
        return False


def notion_append(heading: str, lines: list) -> bool:
    """Append a dated block to the SmartEntry Pro Notion page. Never raises.

    APPEND ONLY. It adds children to the page and never updates or archives an existing
    block, so nothing already written can be lost - the same rule the decision ledger
    and the rejection ledger follow.

    Needs BOTH, and a page id is not a credential:
      NOTION_TOKEN    an internal integration secret (ntn_... / secret_...)
      NOTION_PAGE_ID  defaults to the SmartEntry Pro page id below
    The page must be SHARED with that integration from Notion's UI - a valid token
    against an unshared page returns 404 `object_not_found`, which looks exactly like a
    wrong id. Reported rather than swallowed for that reason.
    """
    token = get_cred("NOTION_TOKEN")
    page  = get_cred("NOTION_PAGE_ID") or "3ce788d6-2fca-81e1-aa28-caf7c4ab6630"
    if not token:
        return False
    try:
        import json as _json
        import urllib.request as _rq
        from datetime import datetime, timezone
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        children = [{
            "object": "block", "type": "heading_3",
            "heading_3": {"rich_text": [{"type": "text",
                          "text": {"content": f"{heading} — {stamp}"[:2000]}}]},
        }]
        for ln in [l for l in lines if str(l).strip()][:90]:   # Notion caps at 100/request
            children.append({
                "object": "block", "type": "paragraph",
                "paragraph": {"rich_text": [{"type": "text",
                              "text": {"content": str(ln)[:2000]}}]},
            })
        req = _rq.Request(
            f"https://api.notion.com/v1/blocks/{page}/children",
            data=_json.dumps({"children": children}).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}",
                     "Notion-Version": "2022-06-28",
                     "Content-Type": "application/json"},
            method="PATCH",
        )
        with _rq.urlopen(req, timeout=15) as r:
            if r.status not in (200, 201):
                print(f"[NOTIFY] Notion HTTP {r.status}")
                return False
        return True
    except Exception as exc:
        print(f"[NOTIFY] Notion append failed, continuing: {exc}")
        return False


def notify_alert(message: str) -> None:
    """
    System alert — toast + webhook + Telegram (no email for alerts).
    Use for: server restart, error recovery, health events.

    Telegram is the only one of the three that reaches a phone and works headless, so
    it is the channel that actually carries an alert off the VPS.
    """
    title = "JARVIS ALERT"
    body = f"JARVIS ALERT: {message}"

    toast(title, body)

    send_telegram(body)

    send_webhook({
        "content": body,
        "embeds": [{
            "title": title,
            "description": body,
            "color": 16776960,  # yellow
        }],
    })


def notify_trade_closed(symbol: str, outcome: str, pnl: float) -> None:
    """
    Trade-closed notification on all channels.
    outcome: WIN | LOSS | BREAKEVEN
    pnl: numeric P&L in account currency
    """
    pnl_sign = "+" if pnl >= 0 else ""
    title = "JARVIS TRADE CLOSED"
    body = f"Trade closed: {symbol} {outcome.upper()} P&L: ${pnl_sign}{pnl:.2f}"

    toast(title, body)

    send_email(
        subject=f"[JARVIS] Trade Closed: {symbol} {outcome.upper()} ${pnl_sign}{pnl:.2f}",
        body=f"{body}\n\nReview the dashboard at http://localhost:3001",
    )

    outcome_upper = outcome.upper()
    if outcome_upper == "WIN":
        embed_color = 3066993   # green
    elif outcome_upper == "LOSS":
        embed_color = 15158332  # red
    else:
        embed_color = 9807270   # grey

    send_webhook({
        "content": body,
        "embeds": [{
            "title": title,
            "description": body,
            "color": embed_color,
            "fields": [
                {"name": "Symbol", "value": symbol, "inline": True},
                {"name": "Outcome", "value": outcome_upper, "inline": True},
                {"name": "P&L", "value": f"${pnl_sign}{pnl:.2f}", "inline": True},
            ],
        }],
    })

    # TRADE CLOSED -> Slack #smartentry-alerts. Same rule as notify_signal: last in
    # the function, advisory only, cannot raise. A closed trade is already recorded in
    # the journal and the learning engine before this line runs, so a failed Slack post
    # loses a notification and never a record.
    send_slack("*" + title + "*" + chr(10) + body)


def run_test() -> None:
    """Send a test notification through every configured channel."""
    print("Running notification test...")

    toast("JARVIS TEST", "Toast channel working.")
    print("  Toast: sent (or silently skipped on non-Windows)")

    send_email(
        subject="[JARVIS] Notification Test",
        body="JARVIS notification engine test — email channel working.",
    )
    email_configured = bool(get_cred("EMAIL_FROM"))
    print(f"  Email: {'sent' if email_configured else 'skipped (not configured)'}")

    send_webhook({"content": "JARVIS notification engine test — webhook channel working."})
    webhook_configured = bool(get_cred("WEBHOOK_URL"))
    print(f"  Webhook: {'sent' if webhook_configured else 'skipped (not configured)'}")

    send_telegram("JARVIS notification engine test — Telegram channel working.")
    telegram_configured = bool(get_cred("TELEGRAM_TOKEN") and get_cred("TELEGRAM_CHAT_ID"))
    print(f"  Telegram: {'sent' if telegram_configured else 'skipped (not configured)'}")

    # Slack and Notion report the SPECIFIC missing credential rather than a bare
    # "not configured". A channel id and a page id are not credentials, and the most
    # likely reason either of these fails is a token that was never added or a
    # bot/integration that was never granted access to the target.
    slack_ok = send_slack("JARVIS notification engine test — Slack channel working.")
    if slack_ok:
        print(f"  Slack:    sent to {get_cred('SLACK_CHANNEL_ID') or 'C0BUC0SQWTW'}")
    elif not get_cred("SLACK_BOT_TOKEN"):
        print("  Slack:    skipped — SLACK_BOT_TOKEN not in keys.env "
              "(needs a xoxb- token with chat:write, and the bot invited to the channel)")
    else:
        print("  Slack:    FAILED — token present but the post was refused (see error above)")

    notion_ok = notion_append("Notification engine test",
                              ["Slack + Notion wiring check from notifications.py test."])
    if notion_ok:
        print(f"  Notion:   appended to {get_cred('NOTION_PAGE_ID') or '3ce788d6-2fca-81e1-aa28-caf7c4ab6630'}")
    elif not get_cred("NOTION_TOKEN"):
        print("  Notion:   skipped — NOTION_TOKEN not in keys.env "
              "(needs an internal integration secret, and the page shared with it)")
    else:
        print("  Notion:   FAILED — token present but the append was refused (see error above)")
    if not telegram_configured:
        print("           ^ this is the only channel that reaches a phone and works "
              "headless; without it the VPS can raise an alert nobody receives.")

    print("Test complete.")


def main() -> None:
    args = sys.argv[1:]

    if not args:
        print(__doc__)
        sys.exit(0)

    command = args[0].lower()

    if command == "signal":
        # python notifications.py signal <SYMBOL> <DIRECTION> <CONFIDENCE> "<summary>"
        if len(args) < 5:
            print("Usage: notifications.py signal SYMBOL DIRECTION CONFIDENCE \"summary\"")
            sys.exit(1)
        notify_signal(
            symbol=args[1].upper(),
            direction=args[2].upper(),
            confidence=args[3],
            summary=" ".join(args[4:]),
        )

    elif command == "alert":
        # python notifications.py alert "message" [--title TITLE] [--channel all|toast|email|webhook]
        if len(args) < 2:
            print("Usage: notifications.py alert \"message\" [--title TITLE] [--channel all|toast|email|webhook]")
            sys.exit(1)
        # Parse flags out of remaining args
        remaining = args[1:]
        title_override = None
        channel = "all"
        msg_parts = []
        i = 0
        while i < len(remaining):
            if remaining[i] == "--title" and i + 1 < len(remaining):
                title_override = remaining[i + 1]; i += 2
            elif remaining[i] == "--channel" and i + 1 < len(remaining):
                channel = remaining[i + 1]; i += 2
            else:
                msg_parts.append(remaining[i]); i += 1
        message = " ".join(msg_parts)
        if not message:
            print("Usage: notifications.py alert \"message\"")
            sys.exit(1)
        _title = title_override or "JARVIS ALERT"
        _body  = message
        if channel in ("all", "toast"):
            toast(_title, _body)
        if channel in ("all", "email"):
            send_email(subject=f"[JARVIS] {_title}", body=_body)
        if channel in ("all", "webhook"):
            send_webhook({"content": _body, "embeds": [{"title": _title, "description": _body, "color": 16776960}]})
        if channel in ("all", "telegram"):
            send_telegram(f"{_title}: {_body}")
        if channel in ("all", "slack"):
            send_slack("*" + _title + "*\n" + _body)
        # Name the channels that were actually CONFIGURED, not just the ones asked for.
        # "Alert sent via all" was printed while WEBHOOK_URL was unset and Telegram was
        # not wired at all, so the line asserted delivery through channels that silently
        # skipped - a success message is worse than none when it cannot fail.
        live = []
        if channel in ("all", "toast"):
            live.append("toast")
        if channel in ("all", "email") and get_cred("EMAIL_FROM"):
            live.append("email")
        if channel in ("all", "webhook") and get_cred("WEBHOOK_URL"):
            live.append("webhook")
        if channel in ("all", "telegram") and get_cred("TELEGRAM_TOKEN") and get_cred("TELEGRAM_CHAT_ID"):
            live.append("telegram")
        # Same rule as the others: name it only if it is actually CONFIGURED. A channel
        # id alone is not a credential, so SLACK_BOT_TOKEN is what decides.
        if channel in ("all", "slack") and get_cred("SLACK_BOT_TOKEN"):
            live.append("slack")
        print(f"[NOTIFY] Alert sent via {'+'.join(live) if live else 'NOTHING CONFIGURED'}"
              f": {_title} — {_body[:80]}")

    elif command == "trade-closed":
        # python notifications.py trade-closed <SYMBOL> <OUTCOME> <PNL>
        if len(args) < 4:
            print("Usage: notifications.py trade-closed SYMBOL OUTCOME PNL")
            sys.exit(1)
        try:
            pnl = float(args[3])
        except ValueError:
            print(f"Invalid PNL value: {args[3]}")
            sys.exit(1)
        notify_trade_closed(symbol=args[1].upper(), outcome=args[2], pnl=pnl)

    elif command == "test":
        run_test()

    else:
        print(f"Unknown command: {command}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
