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
    { href: "/dashboard/performance.html", label: "Performance",
      match: ["/dashboard/performance.html", "/performance"] },
    { href: "/system", label: "System",
      match: ["/system", "/dashboard/system.html"] },
    { sep: true },
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
