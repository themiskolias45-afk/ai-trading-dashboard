'use strict';
/* ============================================================================
   _deflated_bar.cjs — make the trial count BIND instead of merely being printed
   ============================================================================

   THE PROBLEM THIS SOLVES.

   tasks/strategy_search.cjs already counts every candidate it has ever tested and
   prints the total, on the stated principle that "best of 12" and "best of 4,000"
   are different claims and hiding which one you are making is lying by omission.
   That is disclosure. It is not correction. The promotion bar was the incumbent's
   per-fold STANDARD ERROR — a fixed 1-sigma bar that did not move whether the
   searcher had tried three candidates or three thousand.

   Search enough parameter values against the same 2022-2026 bars and one will beat
   the incumbent by a standard error through luck alone. That is not a discovery,
   it is arithmetic, and it is the exact failure mode that makes an automated
   strategy factory dangerous rather than useful: the more it runs, the more
   confident and the more wrong it gets.

   WHAT THIS IS, PRECISELY.

   It is the SELECTION-BIAS term from the Deflated Sharpe Ratio (Bailey & Lopez de
   Prado, 2014), applied to this searcher's own statistic. Under the null that no
   candidate is better than the incumbent, the BEST of N tried candidates still
   scores above zero by chance, and its expected margin is the expected maximum of
   N draws:

     E[max of N] ~ (1 - g) * Z^-1(1 - 1/N)  +  g * Z^-1(1 - 1/(N*e))

   with g the Euler-Mascheroni constant. So the bar a challenger must clear is not
   one standard error, it is E[max of N] standard errors.

   WHAT THIS IS NOT.

   NOT the full Deflated Sharpe Ratio. DSR is defined on a Sharpe ratio and carries
   two more terms for skewness and excess kurtosis of the return series. This
   searcher's statistic is not a Sharpe ratio — it is a worst-fold R margin against
   an incumbent — so those terms have no defined input here and inventing one would
   be worse than omitting it. The multiplicity term is distribution-general (it is
   about the maximum of N draws, not about normality of returns), which is why it
   transfers and the other two do not. Anyone reading a promotion off this should
   know it is corrected for SELECTION and not for NON-NORMALITY.

   IT MUST STAY CLEARABLE. This project has already shipped a safeguard that could
   never pass: the first noise bar used the incumbent's full fold RANGE, came out at
   0.605, and demanded a challenger beat the incumbent by 0.6R per trade. Nothing
   would ever have cleared it, which is decoration shaped like protection. The
   multipliers here are bounded and modest by design:

     N=2   -> 0.56x      N=50   -> 2.25x
     N=10  -> 1.57x      N=100  -> 2.53x
     N=25  -> 1.97x      N=1000 -> 3.24x

   At the 29 trials this searcher has actually run, the bar moves from 1.00x to
   about 1.9x its standard error. That is a real tightening and it is still a bar a
   genuine improvement can clear.
   ============================================================================ */

// Euler-Mascheroni. Named rather than inlined because it appears once and a bare
// 0.5772 in this formula is unreadable.
const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 * Relative error < 1.15e-9 over the open interval, which is far finer than the
 * fold statistics this multiplies.
 *
 * Returns null outside (0,1) rather than +/-Infinity: an infinite bar would make
 * everything unpromotable and read on the report exactly like "found nothing",
 * and this project has already been bitten by a safeguard that fails invisibly.
 */
function inverseNormalCdf(p) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;

  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q, r;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Expected maximum of N independent standard normal draws.
 *
 * This is the number that turns "we tried N things and one of them won" into "how
 * big a win would we have expected from luck alone".
 *
 * N < 2 returns 1: with a single candidate there is no selection to correct for,
 * and the bar falls back to the plain one-standard-error test the searcher used
 * before this existed. Deliberately NOT 0 — a zero bar would make the first
 * candidate of every axis trivially promotable.
 */
function expectedMaxOfN(trials) {
  const n = Math.floor(Number(trials));
  if (!Number.isFinite(n) || n < 2) return 1;

  const zA = inverseNormalCdf(1 - 1 / n);
  const zB = inverseNormalCdf(1 - 1 / (n * Math.E));
  if (zA === null || zB === null) return 1;   // fall back, never to an infinite bar

  const value = (1 - EULER_MASCHERONI) * zA + EULER_MASCHERONI * zB;
  // The approximation dips below 1 for very small N (N=2 gives ~0.52). Never let
  // the corrected bar be LOOSER than the uncorrected one - a multiplicity
  // correction that weakens the test is worse than none.
  return Math.max(value, 1);
}

/**
 * The bar a challenger must beat, in the same units as `standardError`.
 *
 * Returns null when the standard error is unusable, and a null bar means NOTHING
 * is promotable — the safe direction to fail, matching noiseFloor()'s contract.
 */
function deflatedBar(standardError, trials) {
  const se = Number(standardError);
  if (!Number.isFinite(se) || se <= 0) return null;
  const multiple = expectedMaxOfN(trials);
  return {
    bar: se * multiple,
    standardError: se,
    trials: Math.max(0, Math.floor(Number(trials) || 0)),
    multiple,
    basis: "expected max of N draws (Bailey & Lopez de Prado selection-bias term); "
         + "corrected for SELECTION, not for non-normality",
  };
}

module.exports = { inverseNormalCdf, expectedMaxOfN, deflatedBar, EULER_MASCHERONI };

// ── Self-test ───────────────────────────────────────────────────────────────
// `node tasks/_deflated_bar.cjs` checks the approximation against values that are
// known independently, so a future edit that breaks it fails loudly here rather
// than silently changing every promotion decision in the searcher.
if (require.main === module) {
  const checks = [];
  const near = (label, got, want, tol) => {
    const ok = got !== null && Math.abs(got - want) <= tol;
    checks.push({ label, got, want, tol, ok });
  };

  // Inverse normal CDF against standard published quantiles.
  near("z(0.5)",    inverseNormalCdf(0.5),    0.0,      1e-9);
  near("z(0.975)",  inverseNormalCdf(0.975),  1.959964, 1e-5);
  near("z(0.99)",   inverseNormalCdf(0.99),   2.326348, 1e-5);
  near("z(0.001)",  inverseNormalCdf(0.001), -3.090232, 1e-5);
  near("z(0.9)",    inverseNormalCdf(0.9),    1.281552, 1e-5);

  // Out of domain must be null, never Infinity.
  checks.push({ label: "z(0) is null",  got: inverseNormalCdf(0),  want: null, tol: 0,
                ok: inverseNormalCdf(0) === null });
  checks.push({ label: "z(1) is null",  got: inverseNormalCdf(1),  want: null, tol: 0,
                ok: inverseNormalCdf(1) === null });

  // E[max of N] against the exact/known values. E[max of 2] = 1/sqrt(pi).
  near("E[max 2]",    expectedMaxOfN(2),    Math.max(1 / Math.sqrt(Math.PI), 1), 0.05);
  near("E[max 10]",   expectedMaxOfN(10),   1.539, 0.05);
  near("E[max 100]",  expectedMaxOfN(100),  2.508, 0.05);
  near("E[max 1000]", expectedMaxOfN(1000), 3.241, 0.05);

  // Monotonic: more trials can only ever raise the bar.
  let monotonic = true;
  for (let n = 2; n < 500; n++) {
    if (expectedMaxOfN(n + 1) < expectedMaxOfN(n) - 1e-12) { monotonic = false; break; }
  }
  checks.push({ label: "monotonic in N", got: monotonic, want: true, tol: 0, ok: monotonic });

  // Never looser than the uncorrected bar.
  let neverLooser = true;
  for (let n = 0; n < 200; n++) if (expectedMaxOfN(n) < 1) { neverLooser = false; break; }
  checks.push({ label: "never below 1x", got: neverLooser, want: true, tol: 0, ok: neverLooser });

  // Unusable standard error must give a null bar, not a zero one.
  checks.push({ label: "bar(0) is null", got: deflatedBar(0, 10), want: null, tol: 0,
                ok: deflatedBar(0, 10) === null });
  checks.push({ label: "bar(NaN) is null", got: deflatedBar(NaN, 10), want: null, tol: 0,
                ok: deflatedBar(NaN, 10) === null });

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log((c.ok ? "  PASS  " : "  FAIL  ") + c.label.padEnd(18)
      + "got " + String(c.got).slice(0, 12).padEnd(14)
      + (c.want !== null ? "want " + String(c.want).slice(0, 12) : "want null"));
  }
  console.log("");
  console.log("  multiplier table (what the bar becomes, as a multiple of 1 SE):");
  for (const n of [1, 2, 5, 10, 25, 29, 50, 100, 500, 1000, 5000]) {
    console.log("    N=" + String(n).padEnd(6) + expectedMaxOfN(n).toFixed(3) + "x");
  }
  console.log("");
  console.log(failed === 0 ? "ALL CHECKS PASSED" : failed + " CHECK(S) FAILED");
  process.exit(failed === 0 ? 0 : 1);
}
