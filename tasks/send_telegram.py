"""
Send one message to Telegram from STDIN, and SAY WHAT HAPPENED.

WHY THIS EXISTS. notifications.send_telegram() is the right sender - it reads keys.env
directly, works with the server down, and scrubs the bot token out of every error path.
It has two properties that make it unusable straight from a cron job:

  1. It returns None whether it sent or not, and RETURNS SILENTLY when the credentials
     are missing. A caller cannot distinguish "delivered" from "no token configured".
  2. It has no stdin entry point. The `notifications.py alert` CLI takes the body as an
     argv, and these messages are 30 lines of markup - fragile through a shell on a good
     day, and this project has already lost two heredocs to quoting.

A confluence alert that silently fails to send is the exact failure this whole table was
built to prevent: a source that is quiet looking identical to a source that agrees. So
this wrapper reports an explicit verdict on stdout and a non-zero exit on failure.

  SENT       delivered, Telegram accepted it
  NOCONFIG   TELEGRAM_TOKEN or TELEGRAM_CHAT_ID missing from keys.env  (exit 2)
  FAILED     the send raised or Telegram refused it                    (exit 3)
  EMPTY      nothing on stdin                                          (exit 4)

The message is read as UTF-8 from stdin so nothing ever lands in a process argument,
where it would be visible in the process table and mangled by the shell.

  node tasks/confluence.cjs --notify        (calls this)
  echo "hello" | python tasks/send_telegram.py
"""

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

# notifications.py sits at the repo root, this file in tasks/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import notifications  # noqa: E402


def main() -> int:
    raw = sys.stdin.buffer.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # Never drop a message over an encoding fault - degrade, report, still send.
        text = raw.decode("utf-8", errors="replace")
        print("WARN non-utf8 bytes on stdin, replaced")

    text = text.strip()
    if not text:
        print("EMPTY nothing on stdin, nothing sent")
        return 4

    # Telegram rejects anything over 4096 characters outright. Truncating with a visible
    # marker beats a 400 that loses the whole alert.
    LIMIT = 4000
    if len(text) > LIMIT:
        text = text[:LIMIT] + "\n... (truncated, " + str(len(text)) + " chars)"

    token = notifications.get_cred("TELEGRAM_TOKEN")
    chat_id = notifications.get_cred("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        missing = [n for n, v in (("TELEGRAM_TOKEN", token), ("TELEGRAM_CHAT_ID", chat_id)) if not v]
        print("NOCONFIG missing from keys.env: " + ", ".join(missing))
        return 2

    # send_telegram reports its own failures by PRINTING (already token-scrubbed) and
    # returns None either way, so its stdout is the only failure signal there is.
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            notifications.send_telegram(text)
    except Exception as exc:  # noqa: BLE001 - scrub before anything is printed
        print("FAILED " + str(exc).replace(token, "<TELEGRAM_TOKEN>")[:200])
        return 3

    noise = buf.getvalue().strip()
    if noise:
        print("FAILED " + noise.replace(token, "<TELEGRAM_TOKEN>")[:300])
        return 3

    print("SENT " + str(len(text)) + " chars")
    return 0


if __name__ == "__main__":
    sys.exit(main())
