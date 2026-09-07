// Idempotent, all-or-nothing patch of the /api/ai-brain thinking config.
// Asserts the anchor BEFORE writing anything: a patcher that asserts after its
// write leaves the file changed while printing green lines.
const fs = require("fs");
const target = process.argv[2];
const write  = process.argv.includes("--write");
if (!target) { console.error("usage: node patch_aibrain_thinking.cjs <file> [--write]"); process.exit(2); }

const buf = fs.readFileSync(target);
const src = buf.toString("utf8");
const crlf = src.includes("\r\n");
const EOL = crlf ? "\r\n" : "\n";

const OLD = [
'    const msg = await anthropic.messages.create({',
'      model: "claude-opus-5",',
'      max_tokens: 1000,',
'      thinking: { type: "enabled", budget_tokens: 500 },',
'      messages: [{ role: "user", content: prompt }]',
'    });',
].join(EOL);

const NEW = [
'    const msg = await anthropic.messages.create({',
'      model: "claude-opus-5",',
'      // Adaptive thinking, matching the AI-filter call site above. This was',
'      // { type: "enabled", budget_tokens: 500 } until 2026-08-30 - a form that is',
'      // REMOVED on claude-opus-5 and returns 400, with 500 additionally below the',
'      // old 1024 floor, so it failed two independent ways on all three assets on',
'      // every single call. It never surfaced because wrapAnthropicWithCliFallback',
'      // caught the 400 and silently re-served each brief through the Claude CLI:',
'      // the page rendered, the handler logged success, and the only trace was 83',
'      // lines of "[anthropic] API rail failed (400 ... thinking.) - served via',
'      // CLI/subscription". A working fallback masking a broken primary is the',
'      // hardest kind of bug to see, and it cost three CLI subprocesses per load.',
'      //',
'      // max_tokens 1000 -> 4096 is part of the fix, not a tidy-up. With thinking on,',
'      // max_tokens has to cover the thinking AND the reply; left at 1000 the briefs',
'      // would truncate mid-sentence, which looks exactly like the fix not working.',
'      // effort "low" is deliberate and mirrors the filter site: the prompt already',
'      // carries every number, and the ask is a five-sentence brief, not analysis.',
'      max_tokens: 4096,',
'      thinking: { type: "adaptive" },',
'      output_config: { effort: "low" },',
'      messages: [{ role: "user", content: prompt }]',
'    });',
].join(EOL);

if (src.includes(NEW)) { console.log(`ALREADY PATCHED  (${crlf ? "CRLF" : "LF"})  ${target}`); process.exit(0); }
const n = src.split(OLD).length - 1;
if (n !== 1) { console.error(`REFUSING: anchor matched ${n} times (need exactly 1) in ${target}`); process.exit(3); }
if (!write) { console.log(`CHECK OK  anchor matches once  (${crlf ? "CRLF" : "LF"})  ${target}`); process.exit(0); }

fs.copyFileSync(target, `${target}.bak-aibrainthinking-${new Date().toISOString().replace(/[:.]/g,"").slice(0,15)}`);
fs.writeFileSync(target, Buffer.from(src.replace(OLD, NEW), "utf8"));
const after = fs.readFileSync(target).toString("utf8");
console.log(`WROTE  budget_tokens call sites now: ${(after.match(/thinking: \{ type: "enabled"/g)||[]).length}  CRLF preserved: ${after.includes("\r\n") === crlf}`);
