'use strict';
/**
 * Write an analysis artifact, surviving a transient Windows file lock.
 *
 * Four post-close harnesses — time_heatmap, session_walkforward (twice, once per
 * slice), regime_xtab and the deep plan — each spend about two minutes computing and
 * then end with a bare fs.writeFileSync. On the VPS every one of them has failed
 * nightly since 2026-08-16 with:
 *
 *     EPERM: operation not permitted, open '...\tasks\analysis\<name>-latest.json'
 *
 * Not a permissions fault. The directory ACLs give Administrator FullControl, no file
 * carries the ReadOnly attribute, and running the identical step by hand succeeds
 * (time_heatmap, exit 0 after 142.5s). It is transient: Windows reports EPERM rather
 * than EBUSY when another handle holds a file mid-write, and Defender real-time
 * protection is enabled on that box and opens each freshly written JSON to scan it.
 * Both boxes also run their post-close job in the same wall-clock window.
 *
 * The cost of that race is out of all proportion to it: a lock lasting milliseconds
 * discards two minutes of finished computation, and the number never reaches the
 * evidence board.
 *
 * So the fix is not to find the holder — it is to stop caring about it. Retry the
 * write a few times, then fail exactly as before.
 *
 * ONLY transient codes are retried. ENOENT (missing directory), ENOSPC (full disk) and
 * anything else fail immediately: retrying a real fault delays and disguises it, which
 * is the failure mode this whole file exists to end.
 */

const fs = require('fs');

// Windows returns EPERM for a sharing violation on open-for-write; EBUSY and EACCES
// show up on the same class of contention. All three are worth a second attempt.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Three retries over ~2.6s total. Long enough to outlast an antivirus scan of a file
// this size, short enough that a genuinely permanent failure is still reported promptly.
const BACKOFF_MS = [250, 750, 1600];

/** Block the current thread. These harnesses are synchronous scripts, not servers. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} target   absolute path to write
 * @param {string} body     file contents
 * @param {function} [log]  optional reporter for retry notices; defaults to stderr
 * @returns {{attempts:number, retried:boolean}}
 * @throws the original error, untouched, once the retries are spent
 */
function writeArtifactSync(target, body, log) {
  const report = log || (msg => { try { process.stderr.write(msg + '\n'); } catch (_) {} });

  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(target, body);
      if (attempt > 0) {
        report(`[write_artifact] ${target} written on attempt ${attempt + 1} after a transient lock`);
      }
      return { attempts: attempt + 1, retried: attempt > 0 };
    } catch (err) {
      const canRetry = TRANSIENT.has(err.code) && attempt < BACKOFF_MS.length;
      if (!canRetry) {
        // Rethrown unchanged so every existing caller's diagnosis still works — the
        // point is to lose fewer runs, not to change what a real failure looks like.
        throw err;
      }
      report(`[write_artifact] ${err.code} on ${target}, retry ${attempt + 1}/${BACKOFF_MS.length} in ${BACKOFF_MS[attempt]}ms`);
      sleepSync(BACKOFF_MS[attempt]);
    }
  }
}

module.exports = { writeArtifactSync, TRANSIENT, BACKOFF_MS };
