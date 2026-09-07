// Set the RSI ceilings on this box to match the laptop: 88 / 84.
//
// strategy_settings.json is PER-MACHINE and untracked, so a shared commit does not
// carry it. Until both boxes hold the same ceilings they admit different trades from
// identical bars and their journals cannot be pooled.
//
// Written with fs.writeFileSync(..., "utf8"), which emits NO BOM. PowerShell's
// Set-Content -Encoding utf8 DOES emit one, and on 2026-08-02 that silently reset
// this box to built-in defaults — turning fixedLotSize 0.01 into full risk-based
// sizing. Never write this file from PowerShell.
//
// Backs up first and verifies the backup exists before writing. Only the two ceiling
// keys and the audit fields are touched; every other key is carried through verbatim,
// because this file also carries fixedLotSize and the confidence gate.

const fs = require("fs");
const path = require("path");

const P = path.join(__dirname, "server", "strategy_settings.json");
const raw = fs.readFileSync(P, "utf8");
const before = JSON.parse(raw.replace(/^﻿/, ""));

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const bak = `${P}.bak-8884-${stamp}`;
fs.copyFileSync(P, bak);
if (!fs.existsSync(bak)) { console.log("BACKUP FAILED — refusing to write"); process.exit(1); }
console.log("backup: " + path.basename(bak));

console.log("before: momentumRsiMax=" + before.momentumRsiMax +
            " trendFollowRsiMax=" + before.trendFollowRsiMax +
            " gate=" + before.confidenceThreshold +
            " lot=" + before.fixedLotSize);

const after = { ...before,
  momentumRsiMax: 88,
  trendFollowRsiMax: 84,
  updatedAt: new Date().toISOString(),
  updatedBy: "jarvis-daily-unblock-btc",
};

fs.writeFileSync(P, JSON.stringify(after, null, 2) + "\n", "utf8");

// Read back from DISK and re-parse. Proof of a write is the file, not the absence of
// an exception.
const check = fs.readFileSync(P);
const reparsed = JSON.parse(check.toString("utf8").replace(/^﻿/, ""));
console.log("BOM present: " + (check[0] === 0xEF && check[1] === 0xBB && check[2] === 0xBF));
console.log("after : momentumRsiMax=" + reparsed.momentumRsiMax +
            " trendFollowRsiMax=" + reparsed.trendFollowRsiMax +
            " gate=" + reparsed.confidenceThreshold +
            " lot=" + reparsed.fixedLotSize);
console.log("keys preserved: " + (Object.keys(before).every(k => k in reparsed)));
