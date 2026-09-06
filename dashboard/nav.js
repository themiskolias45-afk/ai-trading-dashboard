/* ============================================================================
   SmartEntry Pro — the shared page rail
   ============================================================================

   ONE list of the pages, in one file, rendered identically on all eight. Before
   this, each page carried its own hand-written subset of links and no page listed
   them all — which is how /architecture ended up with exactly one inbound link in
   the entire product, and why adding a ninth page meant editing eight files and
   forgetting at least one.

   WHAT IT TOUCHES: it inserts one element as the first child of <body> and reads
   location.pathname. It adds no listener, mutates nothing else, and posts nothing.
   Load it with `defer` so <body> exists when it runs.

   Adding a page: add one row to PAGES. Nothing else.
   ============================================================================ */
(function () {
  "use strict";

  // Guard against a double include. Two rails would be a visible bug on a page
  // that already links this and then gets it again from a copied header block.
  if (document.getElementById("se-rail")) return;

  // `match` lists every path that IS this page. Each page answers on a clean route
  // AND on its direct static filename under /dashboard — both are reachable and
  // both are linked from somewhere today, so both must light the right tab.
  var PAGES = [
    { href: "/dashboard", label: "Dashboard",
      match: ["/dashboard", "/dashboard/", "/dashboard/index.html"] },
    { href: "/daily-plan", label: "Daily Plan",
      match: ["/daily-plan", "/dashboard/daily-plan.html"] },
    { href: "/command", label: "Command",
      match: ["/command", "/dashboard/command.html"] },
    { sep: true },
    { href: "/strategy", label: "Strategy",
      match: ["/strategy", "/dashboard/strategy.html"] },
    { href: "/report", label: "Robustness",
      match: ["/report", "/dashboard/report.html"] },
    { href: "/lab", label: "Lab",
      match: ["/lab", "/dashboard/lab.html"] },
    { href: "/dashboard/performance.html", label: "Performance",
      match: ["/dashboard/performance.html", "/performance"] },
    // Static path for the same reason as Fleet Map and Performance: it reads a
    // generated JSON out of /dashboard, so it needs no route and no restart.
    { href: "/dashboard/weekly.html", label: "Weekly",
      match: ["/dashboard/weekly.html", "/weekly"] },
    // Static path again: it reads a generated JSON out of /dashboard, so no route
    // and no restart. The nightly deep analysis had no surface at all before this.
    { href: "/dashboard/analysis.html", label: "Analysis",
      match: ["/dashboard/analysis.html", "/analysis"] },
    // Every pipeline stage and whether anything reads what it writes. Static path
    // for the same reason as its neighbours: generated JSON, no route, no restart.
    { href: "/dashboard/pipelines.html", label: "Pipelines",
      match: ["/dashboard/pipelines.html", "/pipelines"] },
    // Static path, same reason as its neighbours: it reads a generated JSON out of
    // /dashboard, so it needs no route in index.js and no server restart to appear.
    { href: "/dashboard/instruments.html", label: "Instruments",
      match: ["/dashboard/instruments.html", "/instruments"] },
    { href: "/system", label: "System",
      match: ["/system", "/dashboard/system.html"] },
    { sep: true },
    // Served from its static path rather than a clean /fleet route, like Performance
    // above: express.static picks up a new file immediately, whereas a clean route
    // needs an app.get in server/index.js and therefore a server restart. The match
    // list carries /fleet anyway, so the tab lights correctly the day that route lands.
    { href: "/dashboard/fleet.html", label: "Fleet Map",
      match: ["/dashboard/fleet.html", "/fleet"] },
    // fleet-map.html is the LAYERED view, added 2026-09-06 ALONGSIDE fleet.html rather
    // than replacing it: if it turns out worse, nothing was lost and nothing needs undoing.
    // It exists because the original covers fleet agreement, the plan, the clock and the
    // ledgers, but has no representation of EXECUTION (MT5 terminals, EA attach, bridge
    // heartbeats, executors), HEALTH (healer, watchdog, restarts) or INTELLIGENCE (agent
    // queue, auth session, RAG) -- so none of the failures found on 2026-09-06 would have
    // shown on it. Both stay linked until one is chosen.
    { href: "/dashboard/system-map.html", label: "System Map",
      match: ["/dashboard/system-map.html"] },
    { href: "/dashboard/system-architecture.html", label: "Architecture v2",
      match: ["/dashboard/system-architecture.html"] },
    { href: "/architecture", label: "Architecture",
      match: ["/architecture", "/dashboard/architecture.html"] },
    { href: "/plan", label: "Systems Plan",
      match: ["/plan", "/dashboard/plan.html"] },
    { sep: true },
    { href: "/jarvis", label: "JARVIS", agent: true,
      match: ["/jarvis", "/dashboard/jarvis.html"] }
  ];

  // Trailing slashes are stripped so "/plan/" and "/plan" are the same page, but the
  // bare root is preserved rather than collapsing to "" — "/" is the marketing page
  // and must not accidentally match anything in the list.
  var here = location.pathname.replace(/\/+$/, "") || "/";

  var rail = document.createElement("nav");
  rail.id = "se-rail";
  rail.className = "se-rail";
  rail.setAttribute("aria-label", "SmartEntry Pro pages");

  var brand = document.createElement("a");
  brand.className = "se-rail-brand";
  brand.href = "/dashboard";
  var icon = document.createElement("img");
  icon.src = "/dashboard/favicon.svg";
  icon.alt = "";
  var word = document.createElement("span");
  word.textContent = "SmartEntry Pro";
  brand.appendChild(icon);
  brand.appendChild(word);
  rail.appendChild(brand);

  var links = document.createElement("div");
  links.className = "se-rail-links";

  for (var i = 0; i < PAGES.length; i++) {
    var page = PAGES[i];
    if (page.sep) {
      var sep = document.createElement("div");
      sep.className = "se-rail-sep";
      links.appendChild(sep);
      continue;
    }
    var link = document.createElement("a");
    link.className = "se-rail-link" + (page.agent ? " se-rail-agent" : "");
    link.href = page.href;
    link.textContent = page.label;
    if (page.match.indexOf(here) !== -1) {
      link.setAttribute("aria-current", "page");
    }
    links.appendChild(link);
  }

  rail.appendChild(links);
  document.body.insertBefore(rail, document.body.firstChild);

  // The current page keeps its tab visible when the row is scrolled at phone width.
  // Guarded: scrollIntoView with options is unsupported on older WebKit, where the
  // one-argument form scrolls the whole document instead — which would jump the page.
  var current = links.querySelector('[aria-current="page"]');
  if (current && typeof current.scrollIntoView === "function") {
    try {
      current.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (e) {
      /* Non-fatal: the tab is simply not auto-scrolled into view. */
    }
  }
})();
