'use strict';
/**
 * What the AI side of this system is made of: skills, agents, MCP tools and the
 * rules that constrain them.
 *
 * The AI Brain page could run three Claude calls but could not tell you what
 * commands exist, which agents can be spawned, or what the 23 MCP tools are. All
 * of it was on disk and none of it was visible.
 *
 * READ-ONLY AND FAIL-SOFT. Every reader is wrapped: a missing directory or a
 * reformatted file yields an empty list and a reason, never a thrown route. This
 * is a catalogue — nothing here executes a skill, spawns an agent or calls a tool.
 */

const fs   = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const COMMANDS_DIR = path.join(PROJECT_ROOT, ".claude", "commands");
const AGENTS_DIR   = path.join(PROJECT_ROOT, ".claude", "agents");
const MCP_FILE     = path.join(__dirname, "mcp_server.js");

const CACHE_MS = 60_000;
let cache = null;
let cachedAt = 0;

/** First non-empty, non-frontmatter, non-heading line — the human summary. */
function firstMeaningfulLine(text) {
  const lines = text.split("\n");
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && line === "---") { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (line === "---") inFrontmatter = false; continue; }
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return "";
}

function frontmatterField(text, field) {
  const match = text.match(new RegExp("^" + field + ":\\s*(.+)$", "m"));
  return match ? match[1].trim() : null;
}

function readMarkdownDir(dir, kind) {
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch (e) {
    return { items: [], error: e.code === "ENOENT" ? dir + " not found" : e.message };
  }
  const items = [];
  for (const file of files.sort()) {
    let text = "";
    try { text = fs.readFileSync(path.join(dir, file), "utf8"); } catch (e) { continue; }
    const name = frontmatterField(text, "name") || file.replace(/\.md$/, "");
    const description = frontmatterField(text, "description") || firstMeaningfulLine(text);
    items.push({
      name,
      kind,
      // Long agent descriptions are a paragraph; the catalogue wants a line.
      description: description.length > 240 ? description.slice(0, 237) + "…" : description,
      file: path.relative(PROJECT_ROOT, path.join(dir, file)).replace(/\\/g, "/"),
    });
  }
  return { items };
}

/**
 * Parse the MCP tool catalogue out of mcp_server.js as TEXT.
 *
 * Deliberately NOT require()d: that file registers a stdin handler and writes a
 * startup banner on load, so importing it from the web server would start a
 * second MCP server inside the process. Parsing is the safe read.
 */
function readMcpTools() {
  let text;
  try { text = fs.readFileSync(MCP_FILE, "utf8"); }
  catch (e) { return { items: [], error: e.message }; }

  const items = [];
  // DIGITS BELONG IN A TOOL NAME. This was /name:\s*'([a-z_]+)'/ and the missing 0-9
  // made `get_mt5_health` unmatchable — the "5" ended the class, so the pattern never
  // reached the closing quote. A real, load-bearing tool (the only authoritative bridge
  // liveness test) was invisible on the AI Brain page and absent from every count, while
  // the page reported a confident "29 tools".
  const namePattern = /name:\s*'([a-z0-9_]+)'/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const toolName = match[1];
    // Take the description string chunks that follow, up to inputSchema.
    const rest = text.slice(match.index, match.index + 3000);
    const descBlock = rest.match(/description:\s*([\s\S]*?)inputSchema/);
    // A TOOL DECLARES ITS DESCRIPTION IMMEDIATELY. Without this test the parser also
    // matched `serverInfo: { name: 'smartentry', version: '2.0.0' }` — the server's own
    // identity — and published it as a read-only tool called "smartentry" with
    // "(no description found)".
    //
    // Measured across the file: all 29 real tools carry `description:` at exactly +6
    // characters after the closing quote of the name; the serverInfo match carries it at
    // +216, borrowed from an unrelated block further down. 40 is a generous bound that
    // separates them structurally. Filtering by name would fix this one case; requiring
    // the SHAPE of a tool fixes the class and cannot invent a capability that does not
    // exist.
    //
    // The two bugs cancelled in the COUNT, which is why neither was ever noticed: one
    // phantom in, one real tool out, "29 tools" either way. A total that is right for
    // two wrong reasons is the hardest kind of wrong to see.
    const NAME_TO_DESCRIPTION_MAX = 40;
    const afterName = text.slice(match.index + match[0].length,
                                 match.index + match[0].length + NAME_TO_DESCRIPTION_MAX);
    if (!/description:/.test(afterName)) continue;
    if (!descBlock) continue;
    let description = "";
    if (descBlock) {
      const pieces = descBlock[1].match(/'((?:[^'\\]|\\.)*)'/g) || [];
      description = pieces.map(p => p.slice(1, -1).replace(/\\'/g, "'")).join("");
    }
    const firstSentence = description.split(". ")[0];
    items.push({
      name: toolName,
      kind: "mcp-tool",
      description: firstSentence ? firstSentence.trim() + "." : "(no description found)",
      // Flags worth seeing at a glance: which tools can change the world.
      mutates: /execute_trade|force_heal|write_memory|log_note|send_alert|full_trade_workflow|size_position/.test(toolName)
        ? /execute_trade|full_trade_workflow/.test(toolName) ? "TRADES" : "writes"
        : "read-only",
    });
  }
  return { items };
}

/**
 * The rules, with a machine-checkable status where one exists. A rule displayed
 * without evidence of enforcement is decoration; where the code genuinely proves
 * it, say so, and where it rests on discipline, say that instead.
 */
function guardrails() {
  return [
    {
      rule: "Observability must never change what trades",
      enforcement: "ENFORCED IN CODE",
      detail: "Every evidence surface returns feedsTheGate:false. The rejection-evidence "
        + "route added 24 lines to index.js, all additions, none referencing "
        + "confidenceThreshold, MIN_RR, gateStats, finalSignal, effectiveThreshold or minStrength.",
    },
    {
      rule: "Self-learning is never blocked or modified",
      enforcement: "ENFORCED IN CODE",
      detail: "Nothing outside /api/trade-closed writes server/learning.json. Shadow "
        + "evidence lives in its own file precisely so the server's in-memory rewrite "
        + "on saveLearning() can never clobber it.",
    },
    {
      rule: "No deleting — ever, without explicit approval",
      // Upgraded from PROCEDURAL 2026-08-24. It was the most-restated standing rule in
      // the project and the one nothing enforced: tasks/hooks/git-safety.ps1 existed,
      // but it ended in an unconditional `exit 0` and was registered "async": true, so
      // it backed things up and then let every destructive command through. Its pattern
      // also missed `git stash` — the command already on record for reverting
      // learning.json off a locked WAL — and missed rm/Remove-Item/del entirely, since
      // it only matched strings beginning with `git`.
      enforcement: "ENFORCED IN CODE",
      detail: "tasks/hooks/git-safety.ps1 is a PreToolUse deny gate on every Bash call. "
        + "It exits 2 — refusing the command — for repo-wide destructive git operations "
        + "(stash, reset --hard, clean -fdx, checkout -f, restore ., push --force) and "
        + "for any rm/Remove-Item/del or truncating '>' aimed at protected data: "
        + "learning.json, journal.json, smartentry.db*, jarvis_memory.json, the "
        + "rejection and search ledgers, and tasks/history. Scratch and temp paths are "
        + "allow-listed so ordinary work never trips it — a guard that fires constantly "
        + "gets switched off, which protects nothing. 31 cases in "
        + "tasks/hooks/test-git-safety.ps1, block and pass halves both. Deliberate "
        + "override is JARVIS_ALLOW_DESTRUCTIVE=1, which is the 'explicit approval' half "
        + "of the rule made explicit. Deploys still back up before replacing "
        + "(index.js.bak-prefvg, .bak-prerejev on the VPS), and the VPS index.js is "
        + "PATCHED, never copied, because its HEAD carries commits this repo lacks.",
    },
    {
      rule: "Unmeasured geometry gets no vote",
      enforcement: "ENFORCED IN CODE",
      detail: "FVG, CRT and AMD feed no confidence, no gate and no sizing. FVG was "
        + "measured, found to have no edge, and is labelled as such on the Overview "
        + "rather than quietly removed or quietly kept.",
    },
    {
      rule: "Where a ledger contradicts a walk-forward, the walk-forward wins",
      enforcement: "PROCEDURAL",
      // RE-CURATED 2026-08-24. This read "+22.47R from rejections" for weeks, which was
      // the figure at 59 episodes. The example it cites has since RESOLVED, and leaving
      // a settled contradiction standing as the live example of the rule teaches the
      // next reader to expect a fight that is over.
      detail: "MIN_RR, and it is now SETTLED. The rule held: the per-direction "
        + "walk-forward was re-run 2026-08-24 on bars 29 days fresher and replicated — "
        + "baseline 1.50/1.50 positive in 5/5 folds at +0.205R/trade over 264 trades, "
        + "and every challenger's gain vanishes when its best fold is removed. The "
        + "ledger then stopped disagreeing on its own: at 59 episodes it read +20.61R "
        + "and COSTING MONEY, at 83 it reads -2.73R and NO MEASURABLE COST. Third time "
        + "a ledger claim has lost to a walk-forward, after BUY_OVERSOLD and MOMENTUM. "
        + "Neither source has moved the setting. Note the two boxes now give OPPOSITE "
        + "ledger verdicts — the laptop still reads COSTING MONEY at 54 episodes — so "
        + "always say which box a ledger figure came from.",
    },
    {
      rule: "Check what already exists before building",
      enforcement: "PROCEDURAL",
      detail: "The rejection scorer, the ledger and shadow learning already existed and "
        + "ran nightly. Only the verdict layer was missing.",
    },
    {
      rule: "No secrets in code, docs or logs",
      enforcement: "ENFORCED IN CODE",
      detail: "apikey.txt and keys.env are untracked; verified with git ls-files.",
    },
  ];
}

function build() {
  const skills = readMarkdownDir(COMMANDS_DIR, "skill");
  const agents = readMarkdownDir(AGENTS_DIR, "agent");
  const tools  = readMcpTools();
  return {
    skills: skills.items,
    skillsError: skills.error || null,
    agents: agents.items,
    agentsError: agents.error || null,
    tools: tools.items,
    toolsError: tools.error || null,
    guardrails: guardrails(),
    counts: {
      skills: skills.items.length,
      agents: agents.items.length,
      tools: tools.items.length,
      toolsThatTrade: tools.items.filter(t => t.mutates === "TRADES").length,
      toolsThatWrite: tools.items.filter(t => t.mutates === "writes").length,
    },
    updatedAt: new Date().toISOString(),
  };
}

function getRegistry() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  cache = build();
  cachedAt = now;
  return cache;
}

module.exports = { getRegistry, readMcpTools, readMarkdownDir, guardrails };
