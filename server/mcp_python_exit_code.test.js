/**
 * The MCP python runner, and whether a failed child can still report success.
 *
 * On 2026-08-23 `log_note` and `write_memory` answered `{ok: true}` for hours while
 * writing nothing at all. The interpreter had been blocked by Smart App Control, the
 * spawn error arrived on stderr, and `runPython` resolves whenever the child printed
 * ANYTHING — so a failure became the "output" and read as success. That half was fixed
 * by checking for an interpreter before spawning.
 *
 * This covers the other half, which survived: the interpreter starts fine, the script
 * runs, and it exits NON-ZERO after printing. `runPython` still resolves, by design —
 * a script can write its file and then die on a cp1252 error in its final print, and
 * that work is not lost. What it cannot do is tell a caller the child failed, and a
 * tool whose whole job is to persist something must know.
 *
 * No fixtures: a script path that does not exist makes python exit non-zero WITH output
 * on stderr, which is exactly the shape being tested.
 *
 * Run: node server/mcp_python_exit_code.test.js
 */
const assert = require('assert');
const mcp = require('./mcp_server');

const MISSING = '__no_such_script_for_the_exit_code_test__.py';
let failures = 0;

async function check(label, fn) {
  try { await fn(); console.log('  PASS  ' + label); }
  catch (e) { failures++; console.error('  FAIL  ' + label + '\n        ' + e.message); }
}

(async () => {
  console.log('\nMCP python runner — exit codes');

  await check('a script that exits non-zero is reported as NOT ok', async () => {
    const r = await mcp.execPython(MISSING);
    assert.strictEqual(r.ok, false, 'expected ok:false for a non-zero exit');
    assert.notStrictEqual(r.exitCode, 0, 'expected a non-zero exit code');
    assert.ok(r.output.length > 0, 'python printed something; it must be preserved');
  });

  await check('a script that succeeds is reported as ok with exit code 0', async () => {
    const r = await mcp.execPython('daily_notes.py', ['today']);
    assert.strictEqual(r.ok, true, 'daily_notes.py today should succeed: ' + r.output.slice(0, 200));
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.timedOut, false);
  });

  // The 14 existing callers read a string and several are fire-and-forget. If this
  // contract moved, their behaviour moved with it.
  await check('runPython keeps its string contract and its tolerance', async () => {
    const out = await mcp.runPython(MISSING);
    assert.strictEqual(typeof out, 'string', 'runPython must still resolve a string');
    assert.ok(out.length > 0,
      'output from a failed-but-talkative child is still returned — that tolerance is '
      + 'deliberate and must not regress');
  });

  await check('pythonFailure names the script and the exit code, and keeps the output', async () => {
    const r = await mcp.execPython(MISSING);
    const f = mcp.pythonFailure('memory.py', r);
    assert.strictEqual(f.ok, false);
    assert.match(f.error, /memory\.py/);
    assert.match(f.error, /exited with code|could not be run|timed out/);
    assert.match(f.error, /nothing was written/);
    assert.strictEqual(f.output, r.output, 'what the child printed must survive the failure');
  });

  await check('an exit code is a NUMBER or null, never a spawn errno string', async () => {
    const r = await mcp.execPython(MISSING);
    assert.ok(r.exitCode === null || typeof r.exitCode === 'number',
      'execFile reports err.code as ENOENT-style strings for spawn failures; only a '
      + 'number is an exit code, and anything else must be null rather than printed '
      + 'where a number belongs');
  });

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  // The require above starts the stdio listener, so nothing would end this process.
  process.exit(failures ? 1 : 0);
})();
