/* ============================================================================
   SmartEntry Pro — the shared freshness module
   ============================================================================

   WHY THIS FILE EXISTS
   "How old is this number" was implemented FIVE times, in five vocabularies.
   Measured 2026-08-24, every one of these shipped simultaneously:

     architecture.html  ago(ms)      90s/90m/48h breakpoints, never says "just now"
     index.html         rsAge()      hours only, says "3h OLD" not "3h ago",
                                     and hardcoded #f59e0b — a colour that is not
                                     in theme.css at all (its amber is #f0b429)
     index.html         healerAge()  bare units, "45s" / "3m", no suffix
     plan.html          agoText()    compound "2h 14m ago", never seconds, never days
     plan.html          (inline)     beat.ageSeconds + 's ago', no function at all

   So the same fact read as "just now" on one page and "0s ago" on another; one
   page could never say "3d ago" and another could never say "45s ago". Same
   failure class as the five copies of the confidence gate and the two replay
   harnesses that disagreed about whether the engine runs — duplicated logic
   drifting apart — except this one is visible to whoever is looking at the screen.

   WHY IT IS MORE THAN COSMETIC
   From the boot file: the healer showed 8/8 green for 8h32m while every python
   process was dead. A tick with no age is not evidence. So this module does not
   only FORMAT an age, it CLASSIFIES one against thresholds the caller states, and
   renders a chip that carries a glyph AND a colour — never colour alone, because
   a reader who cannot separate the greens gets nothing from a coloured dot.

   WHAT IT TOUCHES
   Defines window.SEFresh and, if any element on the page opts in with
   data-se-fresh, starts ONE 30-second ticker. It adds no styles of its own
   (see dashboard/freshness.css), fetches nothing, and mutates only the elements
   that asked for it by attribute. Load it with `defer`.

   Nothing here can affect a signal, a gate, an order or a position. It is a
   string formatter and a class name.
   ============================================================================ */
(function () {
  "use strict";

  // Idempotent: a page that links this twice (or links it and also gets it from a
  // copied header block) must not end up with two tickers writing the same nodes.
  if (window.SEFresh) return;

  // ── The one vocabulary ────────────────────────────────────────────────────
  // Chosen from what already shipped rather than invented: architecture.html's
  // 90s/90m/48h breakpoints are the most considered of the five (90 rather than 60
  // avoids the jump from "89s ago" to "1m ago" reading as a stall), and "just now"
  // is taken from index/plan/daily-plan, which all had it where architecture did not.
  var JUST_NOW_MS = 10 * 1000;
  var SECONDS_UNTIL_MINUTES = 90;
  var MINUTES_UNTIL_HOURS   = 90;
  var HOURS_UNTIL_DAYS      = 48;

  // Default staleness thresholds. Deliberately conservative and ALWAYS overridable:
  // a signal cache 6 minutes old is stale, a walk-forward 6 minutes old is pristine.
  // A caller that does not state its own thresholds gets these and should say so.
  var DEFAULT_STALE_MS = 5 * 60 * 1000;
  var DEFAULT_DEAD_MS  = 30 * 60 * 1000;

  var TICK_MS = 30 * 1000;

  /* Coerce anything a page might hold into epoch milliseconds.
     Pages carry timestamps as ISO strings, Date objects, epoch seconds (the bar
     CSVs and the MT5 payloads) and epoch milliseconds (Date.now() arithmetic).
     Guessing wrong by a factor of 1000 turns a 3-minute age into 2 days, so the
     seconds/millis split is decided by magnitude against a fixed date rather than
     by "looks small": anything below year-2001-in-millis is treated as seconds. */
  var SECONDS_CUTOFF = 1e12;

  function toEpochMs(when) {
    if (when == null) return NaN;
    if (when instanceof Date) return when.getTime();
    if (typeof when === "number") {
      if (!isFinite(when)) return NaN;
      return when < SECONDS_CUTOFF ? when * 1000 : when;
    }
    if (typeof when === "string") {
      var parsed = Date.parse(when);
      if (isFinite(parsed)) return parsed;
      var numeric = Number(when);
      if (isFinite(numeric) && when.trim() !== "") {
        return numeric < SECONDS_CUTOFF ? numeric * 1000 : numeric;
      }
    }
    return NaN;
  }

  /* Format a DURATION. `bare` drops the suffix entirely, which is what
     index.html's healerAge needed — it renders "45s" inline beside its own label
     and reads wrong as "45s ago". */
  function agoMs(ms, opts) {
    opts = opts || {};
    var unknown = opts.unknown != null ? opts.unknown : "unknown";
    if (ms == null || !isFinite(ms)) return unknown;

    var suffix = opts.bare ? "" : " " + (opts.suffix || "ago");
    var seconds = Math.max(0, Math.round(ms / 1000));

    if (!opts.bare && ms < JUST_NOW_MS) return "just now";
    if (seconds < SECONDS_UNTIL_MINUTES) return seconds + "s" + suffix;

    var minutes = Math.round(seconds / 60);
    if (minutes < MINUTES_UNTIL_HOURS) return minutes + "m" + suffix;

    var hours = Math.round(minutes / 60);
    if (hours < HOURS_UNTIL_DAYS) return hours + "h" + suffix;

    return Math.round(hours / 24) + "d" + suffix;
  }

  /* Format a POINT IN TIME. A future timestamp is clamped to 0 rather than
     rendered as a negative age: the MT5 bars legitimately carry broker-clock
     stamps ahead of UTC, and "-1h ago" reads as a bug in the page. */
  function ago(when, opts) {
    var t = toEpochMs(when);
    if (!isFinite(t)) return (opts && opts.unknown != null) ? opts.unknown : "unknown";
    return agoMs(Math.max(0, Date.now() - t), opts);
  }

  function ageMsOf(when) {
    var t = toEpochMs(when);
    return isFinite(t) ? Math.max(0, Date.now() - t) : NaN;
  }

  /* fresh / stale / dead / unknown. Returned as data, not as a colour, so the
     caller decides how to show it and the chip below is only one of the options. */
  function classify(ms, opts) {
    opts = opts || {};
    var stale = isFinite(opts.stale) ? opts.stale : DEFAULT_STALE_MS;
    var dead  = isFinite(opts.dead)  ? opts.dead  : DEFAULT_DEAD_MS;
    if (ms == null || !isFinite(ms)) return "unknown";
    if (ms >= dead)  return "dead";
    if (ms >= stale) return "stale";
    return "fresh";
  }

  // Glyph per state. These differ in SHAPE, not only in colour — a filled disc, a
  // triangle, a cross and a query are separable without seeing any hue at all,
  // which is the whole point of gate 3.
  var GLYPH = { fresh: "●", stale: "▲", dead: "✕", unknown: "?" };
  var WORD  = { fresh: "live", stale: "stale", dead: "not updating", unknown: "unknown" };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Build one freshness chip as an HTML string.
       label  optional text before the age ("signals", "bridge A")
       when   a timestamp, OR pass ageMs for a duration you already computed
       stale/dead  thresholds in ms
     The title attribute carries the exact instant, because a chip that only ever
     says "2h ago" cannot be checked against a log. */
  function chip(opts) {
    opts = opts || {};
    var ms = isFinite(opts.ageMs) ? opts.ageMs : ageMsOf(opts.when);
    var state = classify(ms, opts);
    var text = isFinite(ms) ? agoMs(ms) : (opts.unknown != null ? opts.unknown : "never");

    var exact = "";
    var t = toEpochMs(opts.when);
    if (isFinite(t)) {
      try { exact = new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC"; }
      catch (e) { exact = ""; }
    }
    var title = (opts.label ? opts.label + " — " : "") + WORD[state]
      + (exact ? " — " + exact : "");

    return '<span class="se-fresh is-' + state + '" title="' + escapeHtml(title) + '">'
      + '<span class="se-fresh-glyph" aria-hidden="true">' + GLYPH[state] + "</span>"
      + (opts.label ? '<span class="se-fresh-label">' + escapeHtml(opts.label) + "</span>" : "")
      + '<span class="se-fresh-age">' + escapeHtml(text) + "</span>"
      + '<span class="se-fresh-sr">' + WORD[state] + "</span>"
      + "</span>";
  }

  /* Declarative use: <span data-se-fresh="2026-08-24T04:00:00Z" data-se-label="signals">
     Re-rendered on every tick, so an age on screen keeps counting instead of
     freezing at whatever it said when the page rendered. A "2 min ago" that has
     been sitting there for an hour is not a smaller error than no age at all. */
  function render(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll("[data-se-fresh]");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var raw = node.getAttribute("data-se-fresh");
      if (raw === null || raw === "") continue;
      node.innerHTML = chip({
        when:  raw,
        label: node.getAttribute("data-se-label") || "",
        stale: Number(node.getAttribute("data-se-stale")) || undefined,
        dead:  Number(node.getAttribute("data-se-dead"))  || undefined
      });
    }
    return nodes.length;
  }

  var timer = null;
  function start() {
    if (timer) return;
    // Only spend a timer if something on this page actually opted in.
    if (!document.querySelector("[data-se-fresh]")) return;
    render();
    timer = setInterval(function () { render(); }, TICK_MS);
  }

  window.SEFresh = {
    ago: ago,
    agoMs: agoMs,
    ageMsOf: ageMsOf,
    toEpochMs: toEpochMs,
    classify: classify,
    chip: chip,
    render: render,
    start: start,
    GLYPH: GLYPH,
    DEFAULTS: { staleMs: DEFAULT_STALE_MS, deadMs: DEFAULT_DEAD_MS, tickMs: TICK_MS }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
