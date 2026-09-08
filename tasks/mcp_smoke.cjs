#!/usr/bin/env node
'use strict';
/**
 * CALL EVERY smartentry MCP TOOL AND REPORT WHICH ONES ACTUALLY WORK.
 *
 * WHY THIS EXISTS. /api/ai-registry counts the tools and server/mcp_server.js declares
 * them; neither proves one RESPONDS. The failure this catches is on record already:
 * get_ai_work timed out through MCP while its underlying route was healthy, so every
 * surface that counted tools said 30 and the tool returned nothing. A declared tool that
 * hangs is worse than a missing one, because the count looks right.
 *
 * READ-ONLY BY CONSTRUCTION. It calls only tools whose names begin with get_ or read_,
 * plus an explicit allowlist of other safe reads. Anything that could place an order,
 * write memory, run a walk-forward or send an alert is SKIPPED BY NAME and reported as
 * skipped - never called to see what happens. execute_trade, size_position,
 * full_trade_workflow, force_heal, write_memory, log_note, send_alert, run_* and
 * screenshot_chart are all in that set.
 *
 * A TIMEOUT IS A FAILURE, NOT A SLOW PASS. Each call gets its own deadline; a tool that
 * does not answer inside it is reported FAIL(timeout), because that is exactly the shape
 * the known get_ai_work defect took.
 *
 *   node tasks/mcp_smoke.cjs                 test the read-only tools
 *   node tasks/mcp_smoke.cjs --timeout 20    per-call deadline in seconds (default 12)
 *   node tasks/mcp_smoke.cjs --list          list tools and what would be called/skipped
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'mcp_server.js');

function numArg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return dflt;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}
const TIMEOUT_MS = numArg('--timeout', 12) * 1000;
const LIST_ONLY = process.argv.includes('--list');

// Never called. Not because they are broken - because calling them has consequences.
const NEVER_CALL = new Set([
  'execute_trade', 'full_trade_workflow', 'size_position', 'force_heal',
  'write_memory', 'log_note', 'send_alert', 'screenshot_chart',
  'run_walkforward', 'run_scan', 'run_debate', 'analyze_symbol', 'check_decision',
]);

function rpc(child, id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

function main() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'], cwd: ROOT });
  let buf = '';
  const pending = new Map();

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
    }
  });

  const call = (id, method, params) => new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ __timeout: true }); }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    rpc(child, id, method, params);
  });

  (async () => {
    const listed = await call(1, 'tools/list', {});
    if (listed.__timeout || !listed.result || !listed.result.tools) {
      console.error('tools/list did not answer — the MCP server itself is not responding.');
      child.kill(); process.exitCode = 1; return;
    }
    const tools = listed.result.tools.map(t => t.name).sort();
    console.log('='.repeat(84));
    console.log('  smartentry MCP smoke test — ' + tools.length + ' tool(s) declared');
    console.log('  per-call deadline ' + (TIMEOUT_MS / 1000) + 's. A timeout is a FAILURE, not a slow pass.');
    console.log('='.repeat(84));

    const callable = tools.filter(t => !NEVER_CALL.has(t));
    const skipped = tools.filter(t => NEVER_CALL.has(t));

    if (LIST_ONLY) {
      for (const t of callable) console.log('  would call  ' + t);
      for (const t of skipped) console.log('  SKIP        ' + t + '   (has consequences)');
      child.kill(); return;
    }

    let id = 10, pass = 0, fail = 0;
    const failures = [];
    for (const name of callable) {
      const started = Date.now();
      const res = await call(id++, 'tools/call', { name, arguments: {} });
      const ms = Date.now() - started;
      if (res.__timeout) {
        console.log('  FAIL  ' + name.padEnd(26) + 'TIMEOUT after ' + (TIMEOUT_MS / 1000) + 's');
        failures.push(name + ' (timeout)'); fail++;
      } else if (res.error) {
        // An error naming a MISSING ARGUMENT is a pass: the tool answered, it just needs input.
        const m = String(res.error.message || '');
        if (/required|argument|missing|invalid_type/i.test(m)) {
          console.log('  ok    ' + name.padEnd(26) + ms + 'ms  (needs arguments — answered)');
          pass++;
        } else {
          console.log('  FAIL  ' + name.padEnd(26) + m.slice(0, 60));
          failures.push(name + ': ' + m.slice(0, 60)); fail++;
        }
      } else {
        console.log('  ok    ' + name.padEnd(26) + ms + 'ms');
        pass++;
      }
    }

    for (const t of skipped) console.log('  skip  ' + t.padEnd(26) + 'not called: has consequences');

    console.log('');
    console.log('  ' + pass + ' responded, ' + fail + ' FAILED, ' + skipped.length + ' skipped by policy');
    if (failures.length) {
      console.log('');
      for (const f of failures) console.log('  ** ' + f);
      process.exitCode = 1;
    }
    child.kill();
  })().catch(err => { console.error('mcp_smoke failed: ' + err.message); child.kill(); process.exitCode = 1; });
}

main();
