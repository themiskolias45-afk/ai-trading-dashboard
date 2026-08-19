"""Stops the VPS from polling Telegram getUpdates while a webhook is registered.

Telegram refuses getUpdates whenever a webhook exists - it returns 409 Conflict on
every single call, forever. Measured on the VPS 2026-08-06: the bot carries a
webhook pointing at a Supabase function, so this poller had logged 114 failures in
20 minutes and had never once succeeded since the webhook was set.

The webhook belongs to a separate integration. It is deliberately NOT removed here -
deleting it would silently break whatever consumes it. Polling is simply skipped.
"""
import io
import sys

PATH = r"C:\ai-trading-dashboard\server\index.js"

OLD = """let lastUpdateId = 0;
let telegramPollingStarted = false;
function ensureTelegramPolling() {
  if (telegramPollingStarted || !TELEGRAM_TOKEN) return;
  telegramPollingStarted = true;
  setInterval(pollTelegram, 3000);
  console.log("[telegram] Polling started");
}"""

NEW = """let lastUpdateId = 0;
let telegramPollingStarted = false;
let telegramPollingChecking = false;

// Telegram refuses getUpdates while a webhook is registered - every call comes back
// 409 Conflict, forever, and the catch in pollTelegram turns that into one console
// line every 3 seconds. Measured on the VPS 2026-08-06: 114 failures in 20 minutes
// against a bot whose webhook points at a Supabase function, meaning inbound commands
// had never reached this server at all and the log was pure noise hiding real errors.
//
// The webhook belongs to a separate integration, so it is NOT deleted here - removing
// it would silently break whatever consumes it. Polling is skipped instead.
//
// Checked at runtime rather than hardcoded or env-gated: if the webhook is ever
// removed, the next call re-checks and polling starts with no code change. That is
// also why the early return does NOT set telegramPollingStarted.
async function ensureTelegramPolling() {
  if (telegramPollingStarted || telegramPollingChecking || !TELEGRAM_TOKEN) return;
  telegramPollingChecking = true;
  try {
    let webhookUrl = "";
    try {
      const info = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`,
        { timeout: 10000 }
      );
      webhookUrl = info.data?.result?.url ?? "";
    } catch (e) {
      // A network blip at boot must not permanently disable inbound commands. Fall
      // through and start polling; pollTelegram's own catch handles a live failure.
      console.error("[telegram] getWebhookInfo failed:", e.message);
    }

    if (webhookUrl) {
      console.log(
        `[telegram] Webhook registered (${webhookUrl}) - getUpdates returns 409 on ` +
        `every call, so polling is disabled. Inbound commands go to that webhook, ` +
        `not to this server. Delete the webhook to re-enable polling here.`
      );
      return;
    }

    telegramPollingStarted = true;
    setInterval(pollTelegram, 3000);
    console.log("[telegram] Polling started");
  } finally {
    telegramPollingChecking = false;
  }
}"""

with io.open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

n = src.count(OLD)
print("ensureTelegramPolling block matches:", n)
if n != 1:
    print("ABORT - expected exactly one match")
    sys.exit(1)

src = src.replace(OLD, NEW)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(src)

print("patched OK")
