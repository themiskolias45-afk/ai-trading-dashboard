// THE THREE BOOKS -> dashboard/performance-books.json
//
// The Performance page reads /api/journal, which is SmartEntry only. So it presents one
// book as though it were the whole picture, while two others exist and are invisible there:
//
//   SmartEntry   the bridge and its executors        -602.52 GBP over 25 closed
//   EA CRT       the chart EA, its own magics        -457.52, ALL of it pre-fix
//   TradingView  a separate paper account entirely   -3,607.89 realised
//
// They are NEVER POOLED here and never will be. A single total across three systems on two
// platforms describes none of them, and it would bury the one fact that matters most.
//
// THAT FACT: the system is PROFITABLE IN R AND LOSING IN MONEY. Both numbers are already in
// the journal - realizedR sits on every row beside pnl - and the page shows neither together
// nor per asset. Money is what the account feels; R is what the strategy earned. When they
// disagree the difference is position sizing, not edge, and you cannot see that disagreement
// on any page today.
//
// READ-ONLY. Reads the journal API and two JSON files this system already publishes; writes
// one file. No order, no setting, no gate. feedsTheGate is false and stays false.
//
// UNKNOWN IS NOT ZERO. Any book that cannot be read comes back null and is rendered as
// "could not read", never as a zero that would quietly flatter the total.
//
//   node tasks/performance_books.cjs          write the json
//   node tasks/performance_books.cjs --json   print it, write nothing

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dashboard", "performance-books.json");
const EA_REVIEW = path.join(ROOT, "tasks", "ea_crt_weekly_review.json");
const TV_ACCOUNT = path.join(ROOT, "dashboard", "tv-paper-account.json");
const AS_JSON = process.argv.includes("--json");

function getJson(pathname, timeout = 6000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 3001, path: pathname, timeout }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function readFileJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** SmartEntry, split PER ASSET and reporting money and R side by side.
 *  Per asset because a pooled figure was used to answer asset-specific questions before and
 *  hid that one instrument carried the loss. */
function smartEntryBook(journal) {
  if (!Array.isArray(journal)) return null;
  const closed = journal.filter((t) => t.closeTime && num(t.pnl) !== null);
  const by = {};
  for (const t of closed) {
    const sym = t.symbol || "?";
    by[sym] = by[sym] || { trades: 0, wins: 0, money: 0, r: 0, rTrades: 0 };
    const b = by[sym];
    b.trades += 1;
    b.money += t.pnl;
    if (t.pnl > 0) b.wins += 1;
    if (num(t.realizedR) !== null) { b.r += t.realizedR; b.rTrades += 1; }
  }
  const perAsset = Object.keys(by).sort().map((sym) => {
    const b = by[sym];
    return {
      symbol: sym,
      trades: b.trades,
      winRatePct: Math.round((b.wins * 1000) / b.trades) / 10,
      netMoney: Math.round(b.money * 100) / 100,
      netR: b.rTrades ? Math.round(b.r * 1000) / 1000 : null,
      avgR: b.rTrades ? Math.round((b.r / b.rTrades) * 1000) / 1000 : null,
      rTrades: b.rTrades,
      // The disagreement, named. Positive R with negative money is a SIZING result, not an
      // edge result, and it is the single most useful thing this file can say.
      verdict: (!b.rTrades ? "no R recorded"
        : b.r > 0 && b.money < 0 ? "EDGE POSITIVE, MONEY NEGATIVE - sizing, not edge"
        : b.r > 0 && b.money >= 0 ? "positive in both"
        : b.r <= 0 && b.money < 0 ? "negative in both"
        : "money positive, R negative"),
    };
  });
  const totalMoney = perAsset.reduce((a, x) => a + x.netMoney, 0);
  const rRows = perAsset.filter((x) => x.netR !== null);
  const totalR = rRows.reduce((a, x) => a + x.netR, 0);
  return {
    scope: "SmartEntry engine and its own executors. Not the chart EA, not TradingView.",
    // THIS BOX'S JOURNAL ONLY, and that is a bigger caveat than it sounds. Measured
    // 2026-09-06: the laptop held 9 closed trades and the VPS 13, with ZERO tickets in
    // common - 22 across the fleet, and each box's Performance page was showing under half
    // of them while presenting it as the record. The journal is per-server state and is not
    // in the fleet-compared settings, so nothing anywhere flagged the divergence.
    perBoxWarning: "This is THIS BOX'S journal. The other box keeps its own and they do not "
      + "overlap - neither machine holds the fleet's complete record.",
    trades: closed.length,
    netMoney: Math.round(totalMoney * 100) / 100,
    netR: rRows.length ? Math.round(totalR * 1000) / 1000 : null,
    perAsset,
  };
}

(async function main() {
  const journalResp = await getJson("/api/journal?limit=500");
  const journal = journalResp && Array.isArray(journalResp.journal) ? journalResp.journal : null;
  const smartEntry = smartEntryBook(journal);

  const ea = readFileJson(EA_REVIEW);
  const tv = readFileJson(TV_ACCOUNT);

  const payload = {
    generatedAt: new Date().toISOString(),
    feedsTheGate: false,
    // Stated on the payload so no renderer can present these as one number by accident.
    neverPool: "Three separate books on two platforms. A combined total describes none of "
      + "them and hides which one is losing.",
    books: {
      smartEntry,
      eaCrt: !ea ? null : {
        scope: "The CRT chart EA, by its own magics. Separate from SmartEntry by design.",
        preFix: ea.preFix || null,
        current: ea.current || null,
        note: "preFix is v3.51 and its twin, 2026-07-05..07-15, trailing stop ON. current is "
          + "v3.55/56 with the trail OFF. Never summed: the fixed build must not be averaged "
          + "into a loss it did not cause.",
        sentrySource: ea.liveConfigSentrySource || null,
      },
      tradingViewPaper: !tv ? null : {
        scope: "A separate TradingView paper account. Invisible to /api/mt5/positions and to "
          + "the trade ledger - both are fed from MT5.",
        readable: tv.readable === true,
        summary: tv.summary || null,
        pnl: tv.pnl || null,
        crossCheck: tv.crossCheck || null,
        positions: tv.positionCount,
      },
    },
    note: "Read-only. A book that could not be read is null, never zero.",
  };

  if (AS_JSON) { console.log(JSON.stringify(payload, null, 2)); return; }

  try {
    const tmp = OUT + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, OUT);
  } catch (e) { console.log("  could not write " + OUT + ": " + e.message); }

  const money = (v) => (v === null || v === undefined ? "     -" : (v > 0 ? "+" : "") + v.toFixed(2));
  console.log("");
  console.log("=== THE THREE BOOKS — never pooled ===");
  console.log("");
  if (!smartEntry) {
    console.log("  SmartEntry        COULD NOT READ the journal");
  } else {
    console.log("  SmartEntry        " + smartEntry.trades + " closed   money "
      + money(smartEntry.netMoney) + "   R " + (smartEntry.netR === null ? "-" : smartEntry.netR));
    console.log("    " + "symbol".padEnd(8) + "trades".padEnd(7) + "win%".padEnd(8)
      + "money".padEnd(11) + "R".padEnd(9) + "verdict");
    for (const a of smartEntry.perAsset) {
      console.log("    " + a.symbol.padEnd(8) + String(a.trades).padEnd(7)
        + (a.winRatePct + "%").padEnd(8) + money(a.netMoney).padEnd(11)
        + String(a.netR === null ? "-" : a.netR).padEnd(9) + a.verdict);
    }
  }
  const e = payload.books.eaCrt;
  console.log("");
  console.log("  EA CRT            " + (!e ? "COULD NOT READ"
    : "pre-fix " + money(e.preFix && e.preFix.netProfit) + " over "
      + ((e.preFix && e.preFix.trades) || 0) + "   |   v3.55+ "
      + (e.current ? money(e.current.netProfit) : "no closed trades yet")));
  const t = payload.books.tradingViewPaper;
  console.log("  TradingView paper " + (!t ? "COULD NOT READ"
    : !t.readable ? "could not read the account"
    : "all time " + money(t.pnl && t.pnl.allTime) + "   month " + money(t.pnl && t.pnl.month)
      + "   week " + money(t.pnl && t.pnl.week) + "   today " + money(t.pnl && t.pnl.today)));
  console.log("");
  console.log("  written: " + OUT);
  console.log("");
})();
