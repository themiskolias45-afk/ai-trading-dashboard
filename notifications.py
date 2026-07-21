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


def notify_alert(message: str) -> None:
    """
    System alert — toast + webhook only (no email for alerts).
    Use for: server restart, error recovery, health events.
    """
    title = "JARVIS ALERT"
    body = f"JARVIS ALERT: {message}"

    toast(title, body)

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
        # python notifications.py alert "message text"
        if len(args) < 2:
            print("Usage: notifications.py alert \"message\"")
            sys.exit(1)
        notify_alert(" ".join(args[1:]))

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
