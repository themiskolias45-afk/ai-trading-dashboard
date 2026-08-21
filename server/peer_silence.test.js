/**
 * Tests the peer-silence watcher by EXTRACTING the real functions out of index.js and
 * running them, rather than restating the logic here. A test that re-implements what it
 * checks passes when the shipped code is wrong, which is the only way this test could
 * matter and the only way it could lie.
 *
 * Run: node server/peer_silence.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

/** Pull one top-level `function NAME(...) {...}` out of the source by brace matching. */
function extractFunction(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.js`);
  let i = SRC.indexOf("{", start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const NAMES = ["expectedHeartbeatBoxes", "assessHeartbeats", "escapeTelegramHtml",
               "describeLastKnownState", "silenceAlertText", "recoveryAlertText",
               "peerAlertChatId", "checkPeerSilence"];

const sent = [];
const logged = [];
const sandbox = {
  peerHeartbeats: {},
  HEARTBEAT_STALE_MINUTES: 15,
  peerSilenceAlerted: new Set(),
  TELEGRAM_TOKEN: "token",
  TELEGRAM_CHAT_ID: "chat-1",
  knownChatIds: new Set(),
  process: { env: {}, uptime: () => 9999 },
  sendTelegram: (chatId, text) => { sent.push({ chatId, text }); return Promise.resolve(); },
  console: { log: (...a) => logged.push(a.join(" ")), error: (...a) => logged.push(a.join(" ")) },
};
vm.createContext(sandbox);
vm.runInContext(NAMES.map(extractFunction).join("\n"), sandbox);

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}
function reset(env, heartbeats, uptime = 9999) {
  sent.length = 0; logged.length = 0;
  sandbox.process.env = env;
  sandbox.process.uptime = () => uptime;
  sandbox.peerHeartbeats = heartbeats;
  sandbox.peerSilenceAlerted.clear();
}
const beat = (ageSeconds, state = null) => ({
  box: "THEMIS", status: "ok", detail: null, state,
  at: new Date(Date.now() - ageSeconds * 1000).toISOString(),
});

console.log("peer-silence watcher");

// 1. Fresh heartbeat — silence must not be invented.
reset({ PEER_HEARTBEAT_EXPECT: "THEMIS" }, { THEMIS: beat(120) });
sandbox.checkPeerSilence();
check("fresh heartbeat sends nothing", sent.length === 0, `sent ${sent.length}`);

// 2. The regression that caused this change: 33h silent must alert.
reset({ PEER_HEARTBEAT_EXPECT: "THEMIS" }, { THEMIS: beat(33.4 * 3600, { gate: 70, dailyPnl: 0, halted: false, haltReason: "", settingsError: null, armed: ["A"], bridgesLive: ["A"], bridgesSilent: [] }) });
sandbox.checkPeerSilence();
check("33h silence alerts once", sent.length === 1, `sent ${sent.length}`);
check("alert names the box", sent[0]?.text.includes("THEMIS"));
check("alert states the duration", sent[0]?.text.includes("33h 24m"), sent[0]?.text);
check("alert carries last known state", sent[0]?.text.includes("gate 70") && sent[0]?.text.includes("armed A"));

// 3. Edge-triggered: a continuing outage must not re-send every tick.
sandbox.checkPeerSilence();
sandbox.checkPeerSilence();
check("continuing outage does not repeat", sent.length === 1, `sent ${sent.length}`);

// 4. Recovery fires exactly once, then goes quiet.
sandbox.peerHeartbeats = { THEMIS: beat(30) };
sandbox.checkPeerSilence();
sandbox.checkPeerSilence();
check("recovery alerts once", sent.length === 2 && sent[1].text.includes("IS BACK"), `sent ${sent.length}`);

// 5. peerHeartbeats is in-memory, so a restart must not invent an outage.
reset({ PEER_HEARTBEAT_EXPECT: "THEMIS" }, {}, 60);
sandbox.checkPeerSilence();
check("restart inside grace stays silent", sent.length === 0, `sent ${sent.length}`);

// 6. Past the grace window with no check-in at all IS an outage.
reset({ PEER_HEARTBEAT_EXPECT: "THEMIS" }, {}, 3600);
sandbox.checkPeerSilence();
check("never-checked-in past grace alerts", sent.length === 1 && sent[0].text.includes("not checked in once"), sent[0]?.text);

// 7. The laptop: unset means inert, not broken.
reset({}, { THEMIS: beat(99999) });
sandbox.checkPeerSilence();
check("unset PEER_HEARTBEAT_EXPECT is inert", sent.length === 0, `sent ${sent.length}`);

// 8. A halt reason containing HTML must not silently kill the message.
reset({ PEER_HEARTBEAT_EXPECT: "THEMIS" }, { THEMIS: beat(3600, { gate: 70, dailyPnl: 0, halted: true, haltReason: "losses <3> & rising", settingsError: null, armed: [], bridgesLive: [], bridgesSilent: [] }) });
sandbox.checkPeerSilence();
check("html in halt reason is escaped", sent[0]?.text.includes("&lt;3&gt; &amp; rising"), sent[0]?.text);

// 9. No chat id — must log rather than throw, so the log is still a record.
reset({ PEER_HEARTBEAT_EXPECT: "THEMIS" }, { THEMIS: beat(3600) });
sandbox.TELEGRAM_CHAT_ID = "";
sandbox.checkPeerSilence();
check("missing chat id still logs", sent.length === 0 && logged.some(l => l.includes("PEER SILENT")), logged.join("|"));
sandbox.TELEGRAM_CHAT_ID = "chat-1";

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exitCode = failures ? 1 : 0;
